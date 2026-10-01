// Local-first perimeter (ADR-0017, hard rule 8). Together with binding to
// 127.0.0.1 and SameSite cookies, these checks close the holes behind
// OpenClaw's localhost attacks: a malicious web page open in the user's
// browser must not be able to drive this API.

import { AppError } from "@ofa/core";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reject requests whose Host is not one of ours. Stops DNS rebinding, where
 * an attacker's domain is re-pointed at 127.0.0.1 so their page counts as
 * same-origin with it.
 */
export function hostCheck(allowedHosts: readonly string[]): MiddlewareHandler<AppEnv> {
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return async (c, next) => {
    // The Node adapter builds the URL from the Host header.
    const host = new URL(c.req.url).host.toLowerCase();
    if (!allowed.has(host)) {
      c.get("logger").warn("rejected host", { host });
      throw new AppError("forbidden", "Unknown host. Open the app at its configured APP_URL.");
    }
    await next();
  };
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * CSRF defence for state-changing requests and WebSocket upgrades:
 *
 * 1. The Origin (or, failing that, the Referer) must be an allowed origin.
 *    A request with neither is allowed only if it carries no cookie, since
 *    without a cookie it has no session to abuse (e.g. curl, health probes).
 * 2. Request bodies must be JSON. Browsers cannot send a cross-site JSON body
 *    without a CORS preflight, and this API answers no preflights.
 */
export function originCheck(allowedOrigins: readonly string[]): MiddlewareHandler<AppEnv> {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    if (SAFE_METHODS.has(c.req.method) && !isUpgrade) return next();

    const origin = c.req.header("origin") ?? refererOrigin(c.req.header("referer"));
    if (origin !== undefined) {
      if (!allowed.has(origin)) {
        c.get("logger").warn("rejected origin", { origin, path: c.req.path });
        throw new AppError("forbidden", "Cross-origin request blocked");
      }
    } else if (isUpgrade || c.req.header("cookie")) {
      throw new AppError("forbidden", "Missing Origin header");
    }

    const length = c.req.header("content-length");
    const hasBody = (length !== undefined && length !== "0") || c.req.header("transfer-encoding");
    if (!isUpgrade && hasBody) {
      const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "application/json") {
        throw new AppError("bad_request", "Send request bodies as application/json");
      }
    }

    await next();
  };
}
