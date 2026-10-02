// Composition root (hard rule 2). The only place that chooses adapters.
// Self-host and cloud differ only here; today both use the same ones. Event
// bus and sandbox adapters join in M2–M4.

import type { Config } from "@ofa/config";
import type { CredentialVault, LLMGateway, TenantContext } from "@ofa/core";
import { createDatabase, type Database } from "@ofa/db";
import {
  createModelGateway,
  createOpenRouterProvider,
  parseModelList,
  type ModelProvider,
  type TierOverrides,
} from "@ofa/llm";
import { createUnconfiguredVault, createVault } from "@ofa/vault";
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
  /** Used by the agent runtime (Inngest functions, M2.07); the API never calls models itself. */
  readonly llm: LLMGateway;
  readonly setup: SetupService;
  readonly sessions: SessionService;
  /** Release connections. Call once on shutdown. */
  close(): Promise<void>;
}

export interface ContainerOverrides {
  readonly logger?: Logger;
}

function createLlm(config: Config, vault: CredentialVault): LLMGateway {
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

  return createModelGateway({
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
}

export function createContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger(config.log, { service: "api" });
  const database = createDatabase(config.database.url);
  const auth = createAuth(database.db, config);
  const vault = config.vault.key
    ? createVault({ db: database.db, key: config.vault.key })
    : createUnconfiguredVault();

  return {
    config,
    logger,
    db: database.db,
    auth,
    vault,
    llm: createLlm(config, vault),
    setup: createSetupService({ db: database.db, auth }),
    sessions: createSessionService({ db: database.db, auth }),
    close: () => database.close(),
  };
}
