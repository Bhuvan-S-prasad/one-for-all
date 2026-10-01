import { TenantRequiredError } from "@ofa/core";
import type { MiddlewareHandler } from "hono";
import { unauthorized } from "../lib/errors";
import type { SessionService } from "../services/sessions";
import type { AppEnv } from "../types";

/** Header a client sends to act in a workspace other than its first one. */
export const WORKSPACE_HEADER = "x-workspace-id";

/** 401 unless the request has a valid session cookie. Sets `c.var.session`. */
export function requireSession(sessions: SessionService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const session = await sessions.resolve(c.req.raw.headers, c.req.header(WORKSPACE_HEADER));
    if (!session) throw unauthorized();
    c.set("session", session);
    await next();
  };
}

/**
 * After `requireSession`: resolves the TenantContext every repository call
 * needs (hard rule 3). Sets `c.var.tenant`.
 */
export function requireTenant(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tenant = c.get("session").tenant;
    if (!tenant) throw new TenantRequiredError();
    c.set("tenant", tenant);
    await next();
  };
}
