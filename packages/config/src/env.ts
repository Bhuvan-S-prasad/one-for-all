import { z } from "zod";

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL");

const flag = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const base64Key32 = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "must be 32 random bytes encoded as base64",
  );

/**
 * Every environment variable the system reads. `.env.example` at the repo
 * root documents each one; keep them in sync.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    OFA_MODE: z.enum(["self-host", "cloud"]).default("self-host"),

    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_URL: z.url().default("http://localhost:3000"),
    WEB_DEV_URL: z.url().optional(),

    /** Extra Host header values to accept, comma-separated (e.g. a Tailscale name). */
    ALLOWED_HOSTS: z.string().optional(),

    DATABASE_URL: postgresUrl,
    DATABASE_MIGRATION_URL: postgresUrl.optional(),
    /** Run pending migrations when the app starts (self-host image). */
    DB_MIGRATE_ON_START: flag.optional(),
    /** Where the SQL migrations are; defaults to packages/db/migrations. */
    MIGRATIONS_DIR: z.string().optional(),

    /** Built web app to serve (self-host). Unset in development: Vite serves it. */
    WEB_DIST_DIR: z.string().optional(),

    AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    VAULT_KEY: base64Key32.optional(),
    /** Where the vault key comes from: `env` (VAULT_KEY) or `keychain` (the OS keychain, M4.02). */
    VAULT_KEY_SOURCE: z.enum(["env", "keychain"]).default("env"),
    /** Earlier vault keys, comma-separated, kept while a rotation re-wraps what they encrypted. */
    VAULT_PREVIOUS_KEYS: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean),
      )
      .pipe(z.array(base64Key32))
      .optional(),

    /**
     * Which model provider serves agents (ADR-0022). Switching is this one
     * setting; adding a provider is one file in packages/llm/src/providers.
     */
    LLM_PROVIDER: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "must be a provider ID such as openrouter")
      .default("openrouter"),
    /** Fallback key for the provider. A key saved in Settings (the vault) takes precedence. */
    LLM_API_KEY: z.string().min(8).optional(),
    /** Override the provider's API address (a proxy, or a local server). */
    LLM_BASE_URL: z.url().optional(),
    /** Model chains per tier, comma-separated, best first. Unset keeps the provider's defaults. */
    LLM_MODELS_FAST: z.string().optional(),
    LLM_MODELS_STANDARD: z.string().optional(),
    LLM_MODELS_STRONG: z.string().optional(),

    /** Self-hosted SearXNG for web.search. Unset: web search reports it is not set up. */
    SEARXNG_URL: z.url().optional(),
    /** The agents' computer (M3): its service, reached through the egress container. Unset: no computer tools. */
    SANDBOX_URL: z.url().optional(),
    /** Shared secret with the sandbox service. Never reaches agents. */
    SANDBOX_TOKEN: z.string().min(16, "SANDBOX_TOKEN must be at least 16 characters").optional(),
    /** OTLP/HTTP endpoint for traces (e.g. a local Phoenix). Unset: traces are off (ADR-0019). */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),

    INNGEST_DEV: flag.optional(),
    INNGEST_BASE_URL: z.url().optional(),
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /** `pretty` for humans, `json` for log collectors. Defaults by NODE_ENV. */
    LOG_FORMAT: z.enum(["pretty", "json"]).optional(),
    APP_VERSION: z.string().default("0.0.0-dev"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.AUTH_SECRET.includes("change-me")) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_SECRET"],
        message: "still has the placeholder value from .env.example",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
