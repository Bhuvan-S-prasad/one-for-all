// Composition root (hard rule 2). The only place that chooses adapters.
// Self-host and cloud differ only here. In self-host mode this one process
// runs the API, the Inngest functions (agent runs) and the event bus.

import { createS3BlobStore, setUpGarage, sweepOrphans } from "@ofa/blobs";
import type { Config } from "@ofa/config";
import { loginSecretNames } from "@ofa/core";
import type {
  AgentDirectory,
  ApprovalStore,
  ArtifactStore,
  BlobStore,
  ConnectionStore,
  CredentialVault,
  EventBus,
  LLMGateway,
  MemoryStore,
  RunStore,
  SandboxProvider,
  ScheduleRunner,
  Scheduler,
  TenantContext,
  ThreadStore,
  TokenRefresher,
} from "@ofa/core";
import {
  createAgentDirectory,
  createApprovalStore,
  createConnectionStore,
  createPolicyRuleStore,
  createArtifactStore,
  referencedBlobKeys,
  createDatabase,
  createChatRecordStore,
  createRunStore,
  createThreadStore,
  createToolCallStore,
  listConnectionsDueForRefresh,
  listConsolidationCandidates,
  listDueRoutines,
  type Database,
  type DatabaseHandle,
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
import {
  createMcpConnections,
  createMcpToolkits,
  type McpConnections,
  type McpToolkits,
} from "@ofa/mcp";
import { createMemoryMaintenance, createPgMemoryStore } from "@ofa/memory";
import {
  createFunctions,
  createInngestClient,
  createRunDispatcher,
  type RunDispatcher,
} from "@ofa/orchestrator";
import { createPolicyEngine } from "@ofa/policy";
import { createDockerSandbox } from "@ofa/sandbox";
import { createTelemetry, type TelemetryHandle, type TelemetryOptions } from "@ofa/telemetry";
import {
  builtinTools,
  createSearxngProvider,
  createToolExecutor,
  createToolRegistry,
  type ToolDefinition,
} from "@ofa/tools";
import {
  createOsKeychain,
  createSecretRegistry,
  createUnconfiguredVault,
  createVault,
  resolveVaultKeys,
  rotateInstall,
  type InstallRotation,
  type VaultKeys,
} from "@ofa/vault";
import type { Inngest } from "inngest";
import { createAuth, type Auth } from "./auth/auth";
import { createLogger, type Logger } from "./lib/logger";
import { createRoutineService, type RoutineService } from "./services/routines";
import { createScheduler } from "./services/schedules";
import { createSessionService, type SessionService } from "./services/sessions";
import { createSkillLibrary } from "./services/skills";
import { createSetupService, type SetupService } from "./services/setup";
import { createTeamDirectory } from "./services/team";

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

/** Finishing a vault key rotation at start (M4.02); see vault-rotation.ts. */
export interface VaultRotation {
  readonly keys: VaultKeys;
  /** Re-wrap every workspace's values with the current key; `ownerDb` is the owner connection. */
  run(ownerDb: Database): Promise<InstallRotation>;
  /** Remove the replaced key from the OS keychain, once nothing needs it. */
  forgetPrevious(): void;
}

export interface Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly auth: Auth;
  readonly vault: CredentialVault;
  /** Null when no vault key is configured. */
  readonly vaultRotation: VaultRotation | null;
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
  /** The object store for large artifacts (ADR-0047); null when none is set up. */
  readonly blobs: BlobStore | null;
  readonly approvals: ApprovalStore;
  /** MCP servers and people’s connections to them. */
  readonly connections: ConnectionStore;
  /** The MCP client; null without a vault key, which keeps sign-ins encrypted. */
  readonly mcp: McpConnections | null;
  /** Connected apps as toolkits for agents (M4.05); null without the MCP client. */
  readonly toolkits: McpToolkits | null;
  readonly dispatcher: RunDispatcher;
  /** Routines on the clock and their test runs (M5.06). */
  readonly routines: RoutineService;
  /** Tasks and reminders agents set for later (M5.07). */
  readonly scheduler: Scheduler & ScheduleRunner;
  readonly inngest: Inngest;
  readonly functions: ReturnType<typeof createFunctions>;
  /** What the orchestrator runs agents with. */
  readonly harness: HarnessDeps;
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
  /** Where the container's own logger writes; redaction still applies (tests). */
  readonly logWrite?: (line: string) => void;
  /** Captures spans, as an OTLP endpoint would receive them (tests). */
  readonly telemetryExporter?: TelemetryOptions["exporter"];
  /** Replaces the model gateway (tests use a scripted one). */
  readonly llm?: LLMGateway;
  /** Tools added to the built-ins (tests). */
  readonly extraTools?: readonly ToolDefinition<never>[];
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
    vision: parseModelList(config.llm.models.vision, ids, provider.id),
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

/** The server's own secrets: each is redacted from logs and traces. */
export function configSecrets(config: Config): (string | undefined)[] {
  const passwordIn = (url: string) => {
    try {
      return decodeURIComponent(new URL(url).password) || undefined;
    } catch {
      return undefined;
    }
  };
  return [
    config.auth.secret,
    config.llm.apiKey,
    config.sandbox?.token,
    config.inngest.eventKey,
    config.inngest.signingKey,
    passwordIn(config.database.url),
    passwordIn(config.database.migrationUrl),
  ];
}

/**
 * Background token refresh (M4.06). Finding sign-ins that run out soon spans
 * workspaces, so it reads IDs through the owner connection, as vault rotation
 * does; each refresh then acts as that person, through tenant-scoped queries.
 */
function createTokenRefresher(config: Config, mcp: McpConnections, logger: Logger): TokenRefresher {
  let warned = false;
  return {
    async listDue(before) {
      if (config.database.migrationUrl === config.database.url) {
        if (!warned) {
          logger.warn(
            "mcp: background token refresh needs DATABASE_MIGRATION_URL (the owner connection); sign-ins are refreshed when used meanwhile",
          );
          warned = true;
        }
        return [];
      }
      const owner = createDatabase(config.database.migrationUrl, { max: 1 });
      try {
        return await listConnectionsDueForRefresh(owner.db, before);
      } finally {
        await owner.close();
      }
    },
    async refresh(ctx, serverId) {
      try {
        const outcome = await mcp.refresh(ctx, serverId);
        if (outcome === "sign_in_required") {
          logger.info("mcp: a sign-in expired and needs the person again", { serverId });
        }
        return outcome;
      } catch (error) {
        logger.warn("mcp: couldn't refresh a sign-in; trying again at the next check", {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

/**
 * The owner connection for background work that spans workspaces (finding
 * due routines), opened on first use and kept. Without a separate owner URL
 * there is none, and that work waits.
 */
function createOwnerAccess(config: Config, logger: Logger) {
  let handle: DatabaseHandle | null = null;
  const warned = new Set<string>();
  return {
    async use<T>(what: string, fn: (ownerDb: Database) => Promise<T>, fallback: T): Promise<T> {
      if (config.database.migrationUrl === config.database.url) {
        if (!warned.has(what)) {
          logger.warn(`${what} needs DATABASE_MIGRATION_URL (the owner connection)`);
          warned.add(what);
        }
        return fallback;
      }
      handle ??= createDatabase(config.database.migrationUrl, { max: 1 });
      return fn(handle.db);
    },
    async close() {
      await handle?.close();
    },
  };
}

/** The S3 store, with Garage set up first when it is Garage (ADR-0047). */
function createBlobStore(config: NonNullable<Config["blobs"]>): BlobStore {
  const store = createS3BlobStore(config);
  const { garage } = config;
  return {
    ...store,
    async ready() {
      if (garage) await setUpGarage({ ...garage, ...config });
      await store.ready();
    },
  };
}

export function createContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  // Every secret this process holds, so logs and traces never carry one
  // (hard rule 4): the server's own from config, and what the vault decrypts.
  const secrets = createSecretRegistry();
  secrets.add(configSecrets(config));
  const logger =
    overrides.logger ??
    createLogger(
      {
        ...config.log,
        redact: secrets.redact,
        ...(overrides.logWrite ? { write: overrides.logWrite } : {}),
      },
      { service: "api" },
    );
  const database = createDatabase(config.database.url);
  const { db } = database;
  const auth = createAuth(db, config);
  // The vault key comes from the environment or the OS keychain (M4.02).
  const keychain = () => createOsKeychain();
  const vaultKeys = resolveVaultKeys(config.vault, keychain);
  secrets.add([vaultKeys?.key, ...(vaultKeys?.previousKeys ?? [])]);
  const fullVault = vaultKeys
    ? createVault({
        db,
        key: vaultKeys.key,
        previousKeys: vaultKeys.previousKeys,
        registry: secrets,
      })
    : null;
  const vault = fullVault ?? createUnconfiguredVault();
  const vaultRotation: VaultRotation | null =
    fullVault && vaultKeys
      ? {
          keys: vaultKeys,
          run: (ownerDb) => rotateInstall(fullVault, ownerDb),
          forgetPrevious: () => {
            if (vaultKeys.source === "keychain") keychain().remove("vault-key.previous");
          },
        }
      : null;
  const made = createLlm(config, vault);
  const { provider, tiers } = made;
  const llm = overrides.llm ?? made.llm;
  const telemetry: TelemetryHandle = createTelemetry({
    serviceName: "one-for-all",
    version: config.version,
    endpoint: config.telemetry.otlpEndpoint,
    redact: secrets.redact,
    ...(overrides.telemetryExporter ? { exporter: overrides.telemetryExporter } : {}),
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
  // Artifacts over 1 MB go to the object store (ADR-0047); without one, Postgres keeps them.
  const blobs = config.blobs ? createBlobStore(config.blobs) : null;
  const artifacts = createArtifactStore(db, blobs);
  const approvals = createApprovalStore(db);
  const announceMessage = (workspaceId: string, threadId: string, messageId: string) =>
    publish(workspaceId, { kind: "message.created", threadId, messageId });
  // The other agents a run can hand work to (M5.01) or message (M5.03). A
  // message wakes its agent through the dispatcher, made with Inngest below.
  const team = createTeamDirectory(db, {
    wake: (event) => dispatcher.messageReceived(event),
    announce: announceMessage,
    // Capability cards from grants (ADR-0044); the executor is made below.
    capabilities: (ctx, agentIds) =>
      tools.capabilities ? tools.capabilities(ctx, agentIds) : Promise.resolve(new Map()),
  });
  // Work on the clock (M5.06–07): routines, and what agents set for later.
  const scheduler = createScheduler(db, {
    wake: (event) => dispatcher.scheduleCreated(event),
    announce: announceMessage,
  });
  const owner = createOwnerAccess(config, logger);
  // Skills (M5.08) and nightly memory consolidation (M5.09).
  const skills = createSkillLibrary(db);
  const memoryMaintenance = createMemoryMaintenance(db, {
    candidates: () => owner.use("memory consolidation", listConsolidationCandidates, []),
  });
  const routines = createRoutineService(db, {
    listDue: (now) => owner.use("routines", (ownerDb) => listDueRoutines(ownerDb, now), []),
    announce: announceMessage,
  });
  const connections = createConnectionStore(db);
  // Apps through MCP (ADR-0011): sign-ins are sealed by the vault, so no vault, no connections.
  const mcp = fullVault
    ? createMcpConnections({
        store: connections,
        cipher: fullVault,
        redirectUrl: new URL("/api/connections/callback", config.server.appUrl).href,
      })
    : null;
  const toolkits = mcp
    ? createMcpToolkits({
        connections,
        mcp,
        onSkippedTool: (server, tool, reason) =>
          logger.warn("mcp: left out a tool whose input can’t be checked", {
            server,
            tool,
            reason,
          }),
      })
    : null;

  const tools = createToolExecutor({
    registry: createToolRegistry(
      builtinTools({
        memory,
        search: config.search.searxngUrl
          ? createSearxngProvider({ baseUrl: config.search.searxngUrl })
          : null,
        sandbox,
        team,
        scheduler,
        skills,
        // The screenshot fallback (DT.11) is offered when the run's tier can see images.
        async vision(ctx) {
          const agent = await agents.get(ctx, ctx.agentId);
          return agent ? (await llm.modelFor(agent.modelTier, ctx)).vision : false;
        },
      }).concat(overrides.extraTools ?? []),
    ),
    policy: createPolicyEngine({ agents, rules: createPolicyRuleStore(db) }),
    calls: createToolCallStore(db),
    agents,
    ...(toolkits ? { toolkits } : {}),
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
    approvals,
    team,
    skills,
    // Each agent's working record per chat (ADR-0045).
    chats: createChatRecordStore(db),
    redact: (ctx, text) => vault.redact(ctx, text),
    middleware: [createTelemetryMiddleware(telemetry)],
  };

  const inngest = createInngestClient({
    isDev: config.inngest.dev,
    baseUrl: config.inngest.baseUrl,
    eventKey: config.inngest.eventKey,
  });
  const dispatcher: RunDispatcher = overrides.dispatcher ?? createRunDispatcher(inngest);
  const tokenRefresh = mcp ? createTokenRefresher(config, mcp, logger) : null;
  const functions = createFunctions(inngest, {
    harness,
    runs,
    approvals,
    ...(tokenRefresh ? { tokenRefresh } : {}),
    routines,
    schedules: scheduler,
    memory: memoryMaintenance,
    // Rows of every workspace are checked, so the owner connection (ADR-0047).
    ...(blobs
      ? {
          blobSweep: {
            sweep: (now: Date) =>
              sweepOrphans(
                blobs,
                (keys) =>
                  owner.use(
                    "The object store sweep",
                    (ownerDb) => referencedBlobKeys(ownerDb, keys),
                    // Without the owner connection nothing counts as unused.
                    new Set(keys),
                  ),
                now,
              ),
          },
        }
      : {}),
  });

  return {
    config,
    logger,
    db,
    auth,
    vault,
    vaultRotation,
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
    blobs,
    approvals,
    connections,
    mcp,
    toolkits,
    dispatcher,
    routines,
    scheduler,
    inngest,
    functions,
    harness,
    setup: createSetupService({ db, auth }),
    sessions: createSessionService({ db, auth }),
    async close() {
      await (bus as { close?(): Promise<void> }).close?.();
      await telemetry.shutdown().catch(() => {});
      await owner.close();
      await database.close();
    },
  };
}
