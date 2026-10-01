import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Container } from "./container";
import { toHttpError } from "./lib/errors";
import { rateLimit } from "./lib/rate-limit";
import { clientIp } from "./lib/request";
import { hostCheck, originCheck } from "./middleware/perimeter";
import { requestContext } from "./middleware/request-context";
import { healthRoutes } from "./routes/health";
import { sessionRoutes } from "./routes/session";
import { setupRoutes } from "./routes/setup";
import type { AppEnv } from "./types";
import { mountWebApp } from "./web";

/**
 * Build the HTTP app. Kept separate from `server.ts` so tests can call
 * `app.request()` without opening a port.
 */
export function createApp(container: Container): Hono<AppEnv> {
  const { config, logger } = container;
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    const http = toHttpError(error);
    const log = c.get("logger") ?? logger;
    if (http.unexpected) log.error("unhandled error", { error, path: c.req.path });
    return c.json(http.body, http.status);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  // ── Perimeter (ADR-0017), for every request ──────────────────────────────
  app.use(requestContext(logger));
  app.use(hostCheck(config.server.allowedHosts));
  app.use(originCheck(config.server.allowedOrigins));
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      // Plain http on localhost; HSTS would break it.
      strictTransportSecurity: false,
    }),
  );

  // ── API ──────────────────────────────────────────────────────────────────
  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024 }));
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  // Login and setup: 10 attempts per minute per client address.
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    key: (c) => clientIp(c) ?? "unknown",
  });

  app.route("/api/health", healthRoutes(container));
  app.route("/api/setup", setupRoutes({ ...container, limiter: authLimiter }));
  app.route("/api/session", sessionRoutes({ ...container, limiter: authLimiter }));
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

  // ── Web app (self-host) ──────────────────────────────────────────────────
  if (config.server.webDistDir) mountWebApp(app, config.server.webDistDir);

  return app;
}
