import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "../lib/logger";
import type { AppEnv } from "../types";

/**
 * Give each request an ID and a logger, and log one line when it finishes.
 * The ID is generated here, never taken from the client.
 */
export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    c.set("logger", logger.child({ requestId }));
    c.header("X-Request-Id", requestId);

    const started = performance.now();
    await next();

    const fields = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    };
    // Static files, and the Inngest dev server's polling of /api/inngest,
    // are noise at info level.
    const quiet = c.req.path === "/api/inngest" && c.res.status < 400;
    if (c.req.path.startsWith("/api/") && !quiet) c.get("logger").info("request", fields);
    else c.get("logger").debug("request", fields);
  };
}
