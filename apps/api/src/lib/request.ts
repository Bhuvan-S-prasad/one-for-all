import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import type { RequestMeta } from "../services/setup";

/** Client IP and user agent, for audit entries and rate limiting. */
export function requestMeta(c: Context): RequestMeta {
  return { ipAddress: clientIp(c), userAgent: c.req.header("user-agent") };
}

/**
 * The socket's remote address. Proxy headers are ignored on purpose: the app
 * is not meant to sit behind a proxy that we would have to trust.
 */
export function clientIp(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // No Node socket, e.g. `app.request()` in tests.
    return undefined;
  }
}

/** Forward `Set-Cookie` values from Better Auth to the response. */
export function setCookies(c: Context, cookies: readonly string[]): void {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
}
