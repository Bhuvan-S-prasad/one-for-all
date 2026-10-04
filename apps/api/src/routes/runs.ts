import {
  RUN_PREVIEW_CHARS,
  runListQuerySchema,
  type RunEventList,
  type RunPage,
} from "@ofa/contracts";
import { NotFoundError } from "@ofa/core";
import { getRun, listRunEvents, listRuns, runPreviews } from "@ofa/db";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { toRun, toRunEvent } from "../lib/mappers";
import { readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Runs, for Activity (M2.19):
 *   GET  /api/runs              newest first (?agentId=&status=a,b&q=&limit=&cursor=)
 *   GET  /api/runs/:id
 *   GET  /api/runs/:id/events   the run log in order (?after=<seq>)
 *   POST /api/runs/:id/stop     stop at the next step; finished steps stay done
 *
 * Runs carry the start of what was asked and of the reply, so Activity can
 * tell them apart (UX.10).
 */
export function runRoutes(deps: Pick<Container, "db" | "sessions" | "dispatcher">) {
  const { db } = deps;
  const afterSchema = z.object({ after: z.coerce.number().int().min(-1).optional() });
  const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const tenant = c.get("tenant");
      const query = readQuery(c, runListQuerySchema);
      const page = await listRuns(db, tenant, {
        limit: query.limit,
        agentId: query.agentId,
        before: query.cursor,
        statuses: query.status,
        search: query.q,
      });
      const previews = await runPreviews(
        db,
        tenant,
        page.items.map((r) => r.id),
        RUN_PREVIEW_CHARS,
      );
      return c.json({
        items: page.items.map((r) => ({ ...toRun(r), ...previewOf(previews, r.id) })),
        nextCursor: page.nextCursor,
      } satisfies RunPage);
    })
    .get("/:id", async (c) => {
      const tenant = c.get("tenant");
      const run = await getRun(db, tenant, c.req.param("id"));
      if (!run) throw new NotFoundError("Run");
      const previews = await runPreviews(db, tenant, [run.id], RUN_PREVIEW_CHARS);
      return c.json({ ...toRun(run), ...previewOf(previews, run.id) });
    })
    .get("/:id/events", async (c) => {
      const tenant = c.get("tenant");
      const run = await getRun(db, tenant, c.req.param("id"));
      if (!run) throw new NotFoundError("Run");
      const { after } = readQuery(c, afterSchema);
      const rows = await listRunEvents(db, tenant, run.id, { afterSeq: after });
      const items = rows.map(toRunEvent).filter((e): e is NonNullable<typeof e> => e !== null);
      return c.json({ items } satisfies RunEventList);
    })
    .post("/:id/stop", async (c) => {
      const tenant = c.get("tenant");
      const run = await getRun(db, tenant, c.req.param("id"));
      if (!run) throw new NotFoundError("Run");
      if (!TERMINAL.has(run.status)) {
        await deps.dispatcher.cancelRun({
          workspaceId: tenant.workspaceId,
          userId: tenant.userId,
          runId: run.id,
        });
      }
      return c.json(toRun(run), 202);
    });
}

function previewOf(
  previews: Map<string, { request: string | null; reply: string | null }>,
  runId: string,
) {
  return previews.get(runId) ?? { request: null, reply: null };
}
