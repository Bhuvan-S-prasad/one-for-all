import { randomUUID } from "node:crypto";
import type { Config } from "@ofa/config";
import { schema, type Database } from "@ofa/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * Better Auth over our Drizzle identity tables (ADR-0020).
 *
 * The API calls `auth.api.*` from its own routes instead of mounting Better
 * Auth's HTTP handler, so only the endpoints we expose exist, all behind our
 * perimeter middleware. Public sign-up is off: the owner is created by
 * first-run setup, and later users by invitation.
 */
export function createAuth(db: Database, config: Config) {
  return betterAuth({
    appName: "One-for-All",
    baseURL: config.server.appUrl,
    basePath: "/api/auth",
    secret: config.auth.secret,
    trustedOrigins: [...config.server.allowedOrigins],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // extend at most once a day
    },
    advanced: {
      cookiePrefix: "ofa",
      database: { generateId: () => randomUUID() },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
