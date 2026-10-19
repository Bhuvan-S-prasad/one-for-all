// Entry point: load config, run migrations if asked, serve HTTP.
import { serve } from "@hono/node-server";
import { ConfigError, loadConfig } from "@ofa/config";
import { loadRootEnv, runMigrations } from "@ofa/db";
import { createApp } from "./app";
import { createContainer } from "./container";
import { finishVaultRotation } from "./services/vault-rotation";

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

if (container.vaultRotation) void finishVaultRotation(container.vaultRotation, config, logger);

// The object store (ADR-0047): set Garage up and make sure of the bucket. The
// app still starts without it; artifacts over 1 MB then fail until it is back.
if (container.blobs) {
  await container.blobs.ready().then(
    () => logger.info("object store ready", { endpoint: config.blobs?.endpoint }),
    (error: unknown) =>
      logger.error("object store not ready: large files can't be kept until it is", {
        endpoint: config.blobs?.endpoint,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
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
    // Inside the self-host container the app listens on 0.0.0.0 and Compose
    // publishes it on 127.0.0.1 only (M2.28), so the warning is noise there.
    const inContainer = process.env.OFA_IN_CONTAINER === "1";
    if (!inContainer && config.server.host !== "127.0.0.1" && config.server.host !== "localhost") {
      logger.warn(
        "bound to a non-loopback address; make sure only a trusted network can reach it",
        {
          host: config.server.host,
        },
      );
    }
  },
);

app.injectWebSocket(server);

// Browsers may look `localhost` up as ::1 first (OAuth providers send people
// back to http://localhost:…). Listen on IPv6 loopback too: still this machine
// only (ADR-0017). Without IPv6, or with it already taken, 127.0.0.1 is enough.
const loopbackV6 =
  config.server.host === "127.0.0.1" || config.server.host === "localhost"
    ? serve({ fetch: app.fetch, hostname: "::1", port: config.server.port })
    : null;
if (loopbackV6) {
  app.injectWebSocket(loopbackV6);
  loopbackV6.on("error", (error: NodeJS.ErrnoException) => {
    logger.warn("not listening on IPv6 loopback (::1); use 127.0.0.1 in addresses", {
      code: error.code,
    });
  });
}

// A taken port is the usual start-up failure in development (another API
// still running); say so plainly instead of an unhandled-error stack trace.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.error(
      `port ${config.server.port} is already in use: is another API running? Stop it, or set PORT`,
      { host: config.server.host, port: config.server.port },
    );
  } else {
    logger.error("server failed to start", { error });
  }
  void container.close().finally(() => process.exit(1));
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  server.close();
  loopbackV6?.close();
  await container.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
