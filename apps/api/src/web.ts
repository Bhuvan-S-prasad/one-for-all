import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { AppEnv } from "./types";

/**
 * Serve the built web app (self-host mode, M1.18). Hashed files under
 * `/assets` are cached for a year; every other non-API path gets
 * `index.html` so client-side routes work on reload.
 */
export function mountWebApp(app: Hono<AppEnv>, distDir: string): void {
  const root = resolve(distDir);
  const indexPath = join(root, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`WEB_DIST_DIR has no index.html: ${root}`);
  }
  const indexHtml = readFileSync(indexPath, "utf8");

  app.use(
    "/assets/*",
    async (c, next) => {
      await next();
      if (c.res.status === 200) c.header("Cache-Control", "public, max-age=31536000, immutable");
    },
    serveStatic({ root }),
  );
  // Other files in the build root (favicon, robots.txt).
  app.use("*", serveStatic({ root, index: "__no_index__" }));
  app.get("*", (c) => {
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  });
}
