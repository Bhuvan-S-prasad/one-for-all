import { envSchema, type Env } from "./env";

export type Mode = Env["OFA_MODE"];

export interface Config {
  readonly env: Env["NODE_ENV"];
  readonly mode: Mode;
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly appUrl: string;
    /** Where people use the web app: the Vite dev server in development, else the app itself. */
    readonly webUrl: string;
    /** Origins allowed to call the API (ADR-0017). */
    readonly allowedOrigins: readonly string[];
    /** Host header values accepted; anything else is rejected (DNS-rebinding defence). */
    readonly allowedHosts: readonly string[];
    /** Built web app to serve, if any. */
    readonly webDistDir: string | undefined;
  };
  readonly database: {
    /** App role: row-level security applies. */
    readonly url: string;
    /** Owner role: migrations only. Falls back to `url`. */
    readonly migrationUrl: string;
    readonly migrateOnStart: boolean;
    readonly migrationsDir: string | undefined;
  };
  readonly auth: { readonly secret: string };
  readonly vault: {
    readonly source: "env" | "keychain";
    readonly key: string | undefined;
    readonly previousKeys: readonly string[];
  };
  readonly llm: {
    readonly provider: string;
    readonly apiKey: string | undefined;
    readonly baseUrl: string | undefined;
    /** Comma-separated model lists per tier, parsed by the gateway. */
    readonly models: {
      readonly fast: string | undefined;
      readonly standard: string | undefined;
      readonly strong: string | undefined;
      /** Models that read images (DT.10). */
      readonly vision: string | undefined;
    };
  };
  readonly search: { readonly searxngUrl: string | undefined };
  /** The agents' computer; null when this server has none. */
  readonly sandbox: { readonly url: string; readonly token: string } | null;
  /** The object store (ADR-0047); null keeps every artifact in Postgres. */
  readonly blobs: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /** Set when the store is Garage and the app should set it up. */
    readonly garage: { readonly adminUrl: string; readonly adminToken: string } | null;
  } | null;
  readonly telemetry: { readonly otlpEndpoint: string | undefined };
  readonly inngest: {
    readonly dev: boolean;
    readonly baseUrl: string | undefined;
    readonly eventKey: string | undefined;
    readonly signingKey: string | undefined;
  };
  readonly log: { readonly level: Env["LOG_LEVEL"]; readonly format: "pretty" | "json" };
  readonly version: string;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
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
  const allowedHosts = unique([
    ...allowedOrigins.map((origin) => new URL(origin).host),
    `localhost:${env.PORT}`,
    `127.0.0.1:${env.PORT}`,
    `[::1]:${env.PORT}`,
    // The dev Inngest container calls the app by this name (pnpm infra:up).
    ...(env.NODE_ENV === "development" ? [`host.docker.internal:${env.PORT}`] : []),
    ...(env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);

  return {
    env: env.NODE_ENV,
    mode: env.OFA_MODE,
    server: {
      host: env.HOST,
      port: env.PORT,
      appUrl: env.APP_URL,
      webUrl: new URL(env.WEB_DEV_URL ?? env.APP_URL).origin,
      allowedOrigins,
      allowedHosts,
      webDistDir: env.WEB_DIST_DIR,
    },
    database: {
      url: env.DATABASE_URL,
      migrationUrl: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
      migrateOnStart: env.DB_MIGRATE_ON_START ?? false,
      migrationsDir: env.MIGRATIONS_DIR,
    },
    auth: { secret: env.AUTH_SECRET },
    vault: {
      source: env.VAULT_KEY_SOURCE,
      key: env.VAULT_KEY,
      previousKeys: env.VAULT_PREVIOUS_KEYS ?? [],
    },
    llm: {
      provider: env.LLM_PROVIDER,
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_BASE_URL,
      models: {
        fast: env.LLM_MODELS_FAST,
        standard: env.LLM_MODELS_STANDARD,
        strong: env.LLM_MODELS_STRONG,
        vision: env.LLM_MODELS_VISION,
      },
    },
    search: {
      // `pnpm infra:up` runs SearXNG on 127.0.0.1:8888 for development.
      searxngUrl:
        env.SEARXNG_URL ?? (env.NODE_ENV === "development" ? "http://127.0.0.1:8888" : undefined),
    },
    sandbox: sandboxConfig(env),
    blobs: blobsConfig(env),
    telemetry: { otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT },
    inngest: {
      dev: inngestDev(env),
      baseUrl: env.INNGEST_BASE_URL,
      eventKey: env.INNGEST_EVENT_KEY,
      signingKey: env.INNGEST_SIGNING_KEY,
    },
    log: {
      level: env.LOG_LEVEL,
      format: env.LOG_FORMAT ?? (env.NODE_ENV === "development" ? "pretty" : "json"),
    },
    version: env.APP_VERSION,
  };
}

/**
 * Inngest's dev mode checks no signatures on /api/inngest, whatever the
 * signing key: so it is off once a key is set (unless asked for), and never
 * on in production.
 */
function inngestDev(env: Env): boolean {
  const dev = env.INNGEST_DEV ?? (env.NODE_ENV !== "production" && !env.INNGEST_SIGNING_KEY);
  if (dev && env.NODE_ENV === "production") {
    throw new Error("INNGEST_DEV can't be on in production: Inngest's calls would not be signed");
  }
  return dev;
}

/**
 * `pnpm infra:up` runs Garage for development on 127.0.0.1 with fixed dev
 * credentials (as for the sandbox); elsewhere the endpoint and both keys
 * must be set together, or none for no object store.
 */
function blobsConfig(env: Env): Config["blobs"] {
  const dev = env.NODE_ENV === "development";
  const endpoint = env.BLOB_S3_ENDPOINT ?? (dev ? "http://127.0.0.1:3900" : undefined);
  if (!endpoint) return null;
  const accessKeyId = env.BLOB_S3_ACCESS_KEY_ID ?? (dev ? "GK0a1b2c3d4e5f60718293a4b5" : undefined);
  const secretAccessKey = env.BLOB_S3_SECRET_ACCESS_KEY ?? (dev ? "d".repeat(64) : undefined);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "BLOB_S3_ENDPOINT is set but BLOB_S3_ACCESS_KEY_ID or BLOB_S3_SECRET_ACCESS_KEY is not",
    );
  }
  const adminUrl =
    env.GARAGE_ADMIN_URL ?? (dev && !env.BLOB_S3_ENDPOINT ? "http://127.0.0.1:3903" : undefined);
  const adminToken = env.GARAGE_ADMIN_TOKEN ?? (dev ? "ofa-garage-dev-admin-token" : undefined);
  if (adminUrl && !adminToken)
    throw new Error("GARAGE_ADMIN_URL is set but GARAGE_ADMIN_TOKEN is not");
  return {
    endpoint,
    bucket: env.BLOB_S3_BUCKET,
    region: env.BLOB_S3_REGION,
    accessKeyId,
    secretAccessKey,
    garage: adminUrl && adminToken ? { adminUrl, adminToken } : null,
  };
}

/**
 * `pnpm infra:up` runs the sandbox for development, reachable on
 * 127.0.0.1:7070 with a fixed dev token; elsewhere both must be set.
 */
function sandboxConfig(env: Env): Config["sandbox"] {
  const dev = env.NODE_ENV === "development";
  const url = env.SANDBOX_URL ?? (dev ? "http://127.0.0.1:7070" : undefined);
  const token = env.SANDBOX_TOKEN ?? (dev ? "ofa-sandbox-dev-token" : undefined);
  if (!url) return null;
  if (!token) throw new Error("SANDBOX_URL is set but SANDBOX_TOKEN is not");
  return { url, token };
}
