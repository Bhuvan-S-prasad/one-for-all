import {
  RUN_PREVIEW_CHARS,
  runListQuerySchema,
  type ArtifactList,
  type Handoff,
  type HandoffList,
  type RunEventList,
  type RunPage,
} from "@ofa/contracts";
import { AppError, NotFoundError } from "@ofa/core";
import {
  getRun,
  getThread,
  listMessages,
  listRunEvents,
  listRuns,
  runPreviews,
  runRequestMessage,
} from "@ofa/db";
import { Hono } from "hono";
import { z } from "zod";
import type { Container } from "../container";
import { toRun, toRunEvent } from "../lib/mappers";
import { startAgentTurn } from "../lib/turns";
import { toArtifact } from "./artifacts";
import { readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Runs, for Activity (M2.19):
 *   GET  /api/runs              newest first (?agentId=&status=a,b&q=&limit=&cursor=)
 *   GET  /api/runs/:id
 *   GET  /api/runs/:id/events   the run log in order (?after=<seq>)
 *   POST /api/runs/:id/stop     stop at the next step; finished steps stay done
 *   GET  /api/runs/:id/artifacts what the run produced (M3.06)
 *   GET  /api/runs/:id/handoffs  work it handed to other agents: brief, answer, files (TC.10)
 *   POST /api/runs/:id/retry    ask again: the same message in the same chat, as a new run (UX.12)
 *
 * Runs carry the start of what was asked and of the reply, so Activity can
 * tell them apart (UX.10).
 */
export function runRoutes(
  deps: Pick<Container, "db" | "sessions" | "bus" | "dispatcher" | "runs" | "logger" | "artifacts">,
) {
  const { db } = deps;
  const afterSchema = z.object({ after: z.coerce.number().int().min(-1).optional() });
  const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

  return (
    new Hono<AppEnv>()
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
      .get("/:id/artifacts", async (c) => {
        const tenant = c.get("tenant");
        const run = await getRun(db, tenant, c.req.param("id"));
        if (!run) throw new NotFoundError("Run");
        const items = await deps.artifacts.listForRun(tenant, run.id);
        return c.json({ items: items.map(toArtifact) } satisfies ArtifactList);
      })
      // The work a run handed on (ADR-0032), for the person to see under its
      // reply: each handoff's own thread stays out of their chat list.
      .get("/:id/handoffs", async (c) => {
        const tenant = c.get("tenant");
        const run = await getRun(db, tenant, c.req.param("id"));
        if (!run) throw new NotFoundError("Run");
        const events = await listRunEvents(db, tenant, run.id, { limit: 2_000 });
        const ended = new Map<string, Handoff["status"]>();
        for (const e of events) {
          if (e.type !== "delegation.finished") continue;
          const p = e.payload as { childRunId: string; status: Handoff["status"] };
          ended.set(p.childRunId, p.status);
        }
        const items: Handoff[] = [];
        for (const e of events) {
          if (e.type !== "delegation.started") continue;
          const p = e.payload as { childRunId: string; agentId: string; agentName: string };
          const child = await getRun(db, tenant, p.childRunId);
          const messages = child?.threadId
            ? (await listMessages(db, tenant, child.threadId, { limit: 20 })).items
            : [];
          const fromChild = messages.filter(
            (m) => m.authorType === "agent" && m.authorAgentId === p.agentId,
          );
          const brief = messages.find(
            (m) => m.authorType === "agent" && m.authorAgentId !== p.agentId,
          );
          const files = (await deps.artifacts.listForRun(tenant, p.childRunId)).filter(
            (a) => a.kind === "file",
          );
          items.push({
            childRunId: p.childRunId,
            agentId: p.agentId,
            agentName: p.agentName,
            status: ended.get(p.childRunId) ?? "working",
            brief: brief?.content ?? null,
            reply: fromChild.at(-1)?.content ?? null,
            files: files.map(toArtifact),
          });
        }
        return c.json({ items } satisfies HandoffList);
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
      })
      .post("/:id/retry", async (c) => {
        const tenant = c.get("tenant");
        const run = await getRun(db, tenant, c.req.param("id"));
        if (!run) throw new NotFoundError("Run");
        if (!TERMINAL.has(run.status)) throw new AppError("conflict", "This run is still going");
        const asked = await runRequestMessage(db, tenant, run.id);
        const thread = run.threadId ? await getThread(db, tenant, run.threadId) : null;
        if (!asked || !thread) {
          throw new AppError("bad_request", "Only a run started by a message can be tried again");
        }
        return c.json(await startAgentTurn(deps, tenant, thread, asked.content), 201);
      })
  );
}

function previewOf(
  previews: Map<string, { request: string | null; reply: string | null }>,
  runId: string,
) {
  return previews.get(runId) ?? { request: null, reply: null };
}
