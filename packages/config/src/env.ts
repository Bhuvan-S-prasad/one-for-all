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
