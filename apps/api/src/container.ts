// Composition root (hard rule 2). The only place that chooses adapters.
// Self-host and cloud differ only here. In self-host mode this one process
// runs the API, the Inngest functions (agent runs) and the event bus.

import type { Config } from "@ofa/config";
import { loginSecretNames } from "@ofa/core";
import type {
  AgentDirectory,
  ArtifactStore,
  CredentialVault,
  EventBus,
  LLMGateway,
  MemoryStore,
  RunStore,
  SandboxProvider,
  TenantContext,
  ThreadStore,
} from "@ofa/core";
import {
  createAgentDirectory,
  createArtifactStore,
  createDatabase,
  createRunStore,
  createThreadStore,
  createToolCallStore,
  type Database,
} from "@ofa/db";
import { createPgEventBus, workspaceEvent } from "@ofa/events";
import { createTelemetryMiddleware, type HarnessDeps } from "@ofa/harness";
import {
  createModelGateway,
  createOpenRouterProvider,
  parseModelList,
  resolveTiers,
  type ModelProvider,
  type TierMap,
  type TierOverrides,
} from "@ofa/llm";
import { createPgMemoryStore } from "@ofa/memory";
import {
  createFunctions,
  createInngestClient,
  createRunDispatcher,
  type RunDispatcher,
} from "@ofa/orchestrator";
import { createPolicyEngine } from "@ofa/policy";
import { createDockerSandbox } from "@ofa/sandbox";
import { createTelemetry, type TelemetryHandle } from "@ofa/telemetry";
import {
  builtinTools,
  createSearxngProvider,
  createToolExecutor,
  createToolRegistry,
} from "@ofa/tools";
import { createUnconfiguredVault, createVault } from "@ofa/vault";
import type { Inngest } from "inngest";
import { createAuth, type Auth } from "./auth/auth";
import { createLogger, type Logger } from "./lib/logger";
import { createSessionService, type SessionService } from "./services/sessions";
import { createSetupService, type SetupService } from "./services/setup";

/**
 * Model providers this build can use (ADR-0022). `LLM_PROVIDER` picks one.
 * Adding a provider: write packages/llm/src/providers/<name>.ts, export it,
 * and add one line here. Nothing that calls a model changes.
 */
const MODEL_PROVIDERS: Record<string, (config: Config) => ModelProvider> = {
  openrouter: (config) => createOpenRouterProvider({ baseURL: config.llm.baseUrl }),
};

/** Where a workspace's key for a provider is kept in the vault. */
export function llmKeySecretName(providerId: string): string {
  return `llm.${providerId}.api_key`;
}

export interface Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly auth: Auth;
  readonly vault: CredentialVault;
  /** Used by the agent runtime; the API never calls models itself (hard rule 1). */
  readonly llm: LLMGateway;
  readonly llmProvider: ModelProvider;
  /** Tier chains from the provider's defaults and LLM_MODELS_*. */
  readonly tiers: TierMap;
  readonly bus: EventBus;
  readonly runs: RunStore;
  readonly agents: AgentDirectory;
  readonly threads: ThreadStore;
  readonly memory: MemoryStore;
  /** The agents' computer (M3); null when this server has none. */
  readonly sandbox: SandboxProvider | null;
  readonly artifacts: ArtifactStore;
  readonly dispatcher: RunDispatcher;
  readonly inngest: Inngest;
  readonly functions: ReturnType<typeof createFunctions>;
  readonly setup: SetupService;
  readonly sessions: SessionService;
  /** Release connections and flush telemetry. Call once on shutdown. */
  close(): Promise<void>;
}

export interface ContainerOverrides {
  readonly logger?: Logger;
  /** Replace the event bus (tests use the in-memory bus). */
  readonly bus?: EventBus & { close?(): Promise<void> };
  readonly dispatcher?: RunDispatcher;
}

function createLlm(
  config: Config,
  vault: CredentialVault,
): { llm: LLMGateway; provider: ModelProvider; tiers: TierMap } {
  const makeProvider = MODEL_PROVIDERS[config.llm.provider];
  if (!makeProvider) {
    const known = Object.keys(MODEL_PROVIDERS).join(", ");
    throw new Error(`Unknown LLM_PROVIDER "${config.llm.provider}". Known providers: ${known}`);
  }
  const provider = makeProvider(config);
  const ids = [provider.id];
  const tiers: TierOverrides = {
    fast: parseModelList(config.llm.models.fast, ids, provider.id),
    standard: parseModelList(config.llm.models.standard, ids, provider.id),
    strong: parseModelList(config.llm.models.strong, ids, provider.id),
  };

  const llm = createModelGateway({
    providers: [provider],
    tiers,
    // The workspace's own key from Settings wins; the environment key is a
    // fallback for development and single-user installs.
    async apiKey(ctx: TenantContext, p: ModelProvider) {
      const ref = await vault.find(ctx, llmKeySecretName(p.id));
      if (ref) return vault.reveal(ctx, ref);
      return p.id === config.llm.provider ? config.llm.apiKey : undefined;
    },
  });
  return { llm, provider, tiers: resolveTiers(provider, tiers) };
}

export function createContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger(config.log, { service: "api" });
  const database = createDatabase(config.database.url);
  const { db } = database;
  const auth = createAuth(db, config);
  const vault = config.vault.key
    ? createVault({ db, key: config.vault.key })
    : createUnconfiguredVault();
  const { llm, provider, tiers } = createLlm(config, vault);
  const telemetry: TelemetryHandle = createTelemetry({
    serviceName: "one-for-all",
    version: config.version,
    endpoint: config.telemetry.otlpEndpoint,
  });

  // Event bus: Postgres LISTEN/NOTIFY in self-host (ADR-0007).
  const bus = overrides.bus ?? createPgEventBus({ url: config.database.url });
  const publish = (workspaceId: string, payload: Parameters<typeof workspaceEvent>[1]) =>
    bus.publish(workspaceEvent(workspaceId, payload));
  const runs = createRunStore(db, { publish });
  const threads = createThreadStore(db, { publish });
  const agents = createAgentDirectory(db);
  const memory = createPgMemoryStore(db);
  // The agents' computer: the Docker sandbox in self-host (ADR-0025).
  const sandbox = config.sandbox ? createDockerSandbox(config.sandbox) : null;
  const artifacts = createArtifactStore(db);

  const tools = createToolExecutor({
    registry: createToolRegistry(
      builtinTools({
        memory,
        search: config.search.searxngUrl
          ? createSearxngProvider({ baseUrl: config.search.searxngUrl })
          : null,
        sandbox,
      }),
    ),
    policy: createPolicyEngine({ agents }),
    calls: createToolCallStore(db),
    agents,
    redact: (ctx, text) => vault.redact(ctx, text),
    artifacts,
    // Saved logins, decrypted only here, when use_saved_login asks (ADR-0012).
    async logins(ctx, site) {
      const names = loginSecretNames(site);
      const [userRef, passwordRef] = await Promise.all([
        vault.find(ctx, names.username),
        vault.find(ctx, names.password),
      ]);
      if (!userRef || !passwordRef) return null;
      const { username } = JSON.parse(await vault.reveal(ctx, userRef)) as { username: string };
      return { username, password: await vault.reveal(ctx, passwordRef) };
    },
    telemetry,
  });

  const harness: HarnessDeps = {
    llm,
    tools,
    runs,
    agents,
    threads,
    memory,
    middleware: [createTelemetryMiddleware(telemetry)],
  };

  const inngest = createInngestClient({
    isDev: config.inngest.dev,
    baseUrl: config.inngest.baseUrl,
    eventKey: config.inngest.eventKey,
  });
  const functions = createFunctions(inngest, { harness, runs });

  return {
    config,
    logger,
    db,
    auth,
    vault,
    llm,
    llmProvider: provider,
    tiers,
    bus,
    runs,
    agents,
    threads,
    memory,
    sandbox,
    artifacts,
    dispatcher: overrides.dispatcher ?? createRunDispatcher(inngest),
    inngest,
    functions,
    setup: createSetupService({ db, auth }),
    sessions: createSessionService({ db, auth }),
    async close() {
      await (bus as { close?(): Promise<void> }).close?.();
      await telemetry.shutdown().catch(() => {});
      await database.close();
    },
  };
}
