import type { Config } from "@ofa/config";
import type { HealthResponse } from "@ofa/contracts";
import { pingDatabase, type Database } from "@ofa/db";
import { Hono } from "hono";
import type { AppEnv } from "../types";

/** `GET /api/health`: public liveness and dependency check (Docker healthcheck). */
export function healthRoutes(deps: { db: Database; config: Config }) {
  return new Hono<AppEnv>().get("/", async (c) => {
    const database = (await pingDatabase(deps.db)) ? "ok" : "error";
    const body: HealthResponse = {
      status: database === "ok" ? "ok" : "degraded",
      version: deps.config.version,
      mode: deps.config.mode,
      checks: { database },
    };
    return c.json(body, database === "ok" ? 200 : 503);
  });
}
