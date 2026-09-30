import { envSchema, type Env } from "./env";

export type Mode = Env["OFA_MODE"];

export interface Config {
  readonly env: Env["NODE_ENV"];
  readonly mode: Mode;
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly appUrl: string;
    /** Origins allowed to call the API (ADR-0017). */
    readonly allowedOrigins: readonly string[];
  };
  readonly database: {
    /** App role: row-level security applies. */
    readonly url: string;
    /** Owner role: migrations only. Falls back to `url`. */
    readonly migrationUrl: string;
  };
  readonly auth: { readonly secret: string };
  readonly vault: { readonly key: string | undefined };
  readonly inngest: {
    readonly dev: boolean;
    readonly baseUrl: string | undefined;
    readonly eventKey: string | undefined;
    readonly signingKey: string | undefined;
  };
  readonly logLevel: Env["LOG_LEVEL"];
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Treat empty values (`KEY=` in .env) as unset. */
function dropEmpty(source: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") result[key] = value;
  }
  return result;
}

/**
 * Parse and validate configuration. Apps load `.env` into the process
 * environment before calling this (e.g. `node --env-file-if-exists=.env`).
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(dropEmpty(source));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  const env = parsed.data;
  const allowedOrigins = [env.APP_URL, env.WEB_DEV_URL]
    .filter((origin): origin is string => origin !== undefined)
    .map((origin) => new URL(origin).origin);

  return {
    env: env.NODE_ENV,
    mode: env.OFA_MODE,
    server: {
      host: env.HOST,
      port: env.PORT,
      appUrl: env.APP_URL,
      allowedOrigins,
    },
    database: {
      url: env.DATABASE_URL,
      migrationUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
    },
    auth: { secret: env.AUTH_SECRET },
    vault: { key: env.VAULT_KEY },
    inngest: {
      dev: env.INNGEST_DEV ?? env.NODE_ENV !== "production",
      baseUrl: env.INNGEST_BASE_URL,
      eventKey: env.INNGEST_EVENT_KEY,
      signingKey: env.INNGEST_SIGNING_KEY,
    },
    logLevel: env.LOG_LEVEL,
  };
}
