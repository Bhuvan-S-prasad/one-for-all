// Composition root (hard rule 2). The only place that chooses adapters.
// Self-host and cloud differ only here; today both use the same ones. Model
// gateway, event bus, vault and sandbox adapters join in M2–M4.

import type { Config } from "@ofa/config";
import { createDatabase, type Database } from "@ofa/db";
import { createAuth, type Auth } from "./auth/auth";
import { createLogger, type Logger } from "./lib/logger";
import { createSessionService, type SessionService } from "./services/sessions";
import { createSetupService, type SetupService } from "./services/setup";

export interface Container {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly auth: Auth;
  readonly setup: SetupService;
  readonly sessions: SessionService;
  /** Release connections. Call once on shutdown. */
  close(): Promise<void>;
}

export interface ContainerOverrides {
  readonly logger?: Logger;
}

export function createContainer(config: Config, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger(config.log, { service: "api" });
  const database = createDatabase(config.database.url);
  const auth = createAuth(database.db, config);

  return {
    config,
    logger,
    db: database.db,
    auth,
    setup: createSetupService({ db: database.db, auth }),
    sessions: createSessionService({ db: database.db, auth }),
    close: () => database.close(),
  };
}
