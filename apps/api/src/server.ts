// Entry point: load config, run migrations if asked, serve HTTP.
import { serve } from "@hono/node-server";
import { ConfigError, loadConfig } from "@ofa/config";
import { loadRootEnv, runMigrations } from "@ofa/db";
import { createApp } from "./app";
import { createContainer } from "./container";

// In the repo (pnpm dev), read the root .env. In the Docker image there is no
// repo root and the environment comes from Compose.
loadRootEnv();

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const container = createContainer(config);
const { logger } = container;

if (config.database.migrateOnStart) {
  logger.info("applying migrations");
  await runMigrations(config.database.migrationUrl, config.database.migrationsDir);
}

const app = createApp(container);
const server = serve(
  { fetch: app.fetch, hostname: config.server.host, port: config.server.port },
  (info) => {
    logger.info("listening", {
      url: `http://${info.address}:${info.port}`,
      appUrl: config.server.appUrl,
      mode: config.mode,
      version: config.version,
    });
    if (config.server.host !== "127.0.0.1" && config.server.host !== "localhost") {
      logger.warn(
        "bound to a non-loopback address; make sure only a trusted network can reach it",
        {
          host: config.server.host,
        },
      );
    }
  },
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  server.close();
  await container.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
