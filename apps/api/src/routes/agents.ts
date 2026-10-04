import {
  createAgentRequestSchema,
  RUN_PREVIEW_CHARS,
  THREAD_PREVIEW_CHARS,
  threadListQuerySchema,
  toAgentSlug,
  updateAgentRequestSchema,
  type AgentListResponse,
  type AgentStatsList,
  type ThreadSummaryPage,
} from "@ofa/contracts";
import { NotFoundError } from "@ofa/core";
import { workspaceEvent } from "@ofa/events";
import {
  agentRunStats,
  createAgent,
  directThread,
  getAgent,
  listAgents,
  listDirectThreads,
  newDirectThread,
  recordAudit,
  runPreviews,
  updateAgent,
} from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toAgent, toRun, toThread, toThreadSummary } from "../lib/mappers";
import { requestMeta } from "../lib/request";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Agents (M2.19):
 *   GET   /api/agents             list (not archived)
 *   POST  /api/agents             hatch an agent
 *   GET   /api/agents/:id
 *   PATCH /api/agents/:id         edit, pause, archive
 *   GET   /api/agents/:id/thread  the person's current chat with it (created on first use)
 *   GET   /api/agents/:id/threads its chats with the person, most recent first (?q=&cursor=) (UX.13)
 *   POST  /api/agents/:id/threads start a new chat (an empty current chat is reused)
 *   GET   /api/agents/stats       per agent: runs this week and the last good result (UX.12)
 */
export function agentRoutes(deps: Pick<Container, "db" | "sessions" | "bus">) {
  const { db } = deps;
  const announce = (workspaceId: string, agentId: string) =>
    deps.bus
      .publish(workspaceEvent(workspaceId, { kind: "agent.updated", agentId }))
      .catch(() => {});

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const items = await listAgents(db, c.get("tenant"));
      return c.json({ items: items.map(toAgent) } satisfies AgentListResponse);
    })
    .get("/stats", async (c) => {
      const tenant = c.get("tenant");
      const weekAgo = new Date(Date.now() - 7 * 86_400_000);
      const stats = await agentRunStats(db, tenant, weekAgo);
      const lastIds = stats.flatMap((s) => (s.lastSucceeded ? [s.lastSucceeded.id] : []));
      const previews = await runPreviews(db, tenant, lastIds, RUN_PREVIEW_CHARS);
      return c.json({
        items: stats.map((s) => ({
          agentId: s.agentId,
          runsThisWeek: s.runsSince,
          lastResult: s.lastSucceeded
            ? {
                ...toRun(s.lastSucceeded),
                ...(previews.get(s.lastSucceeded.id) ?? { request: null, reply: null }),
              }
            : null,
        })),
      } satisfies AgentStatsList);
    })
    .post("/", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, createAgentRequestSchema);
      const agent = await createAgent(db, tenant, {
        ...input,
        slug: input.slug ?? toAgentSlug(input.name),
      });
      await recordAudit(db, tenant, {
        action: "agent.created",
        targetType: "agent",
        targetId: agent.id,
        data: { name: agent.name, grants: input.grants },
        ...requestMeta(c),
      });
      await announce(tenant.workspaceId, agent.id);
      return c.json(toAgent(agent), 201);
    })
    .get("/:id", async (c) => {
      const agent = await getAgent(db, c.get("tenant"), c.req.param("id"));
      if (!agent) throw new NotFoundError("Agent");
      return c.json(toAgent(agent));
    })
    .patch("/:id", async (c) => {
      const tenant = c.get("tenant");
      const patch = await readJson(c, updateAgentRequestSchema);
      const agent = await updateAgent(db, tenant, c.req.param("id"), patch);
      if (!agent) throw new NotFoundError("Agent");
      if (patch.grants || patch.status) {
        // Permission changes are security-relevant (ARCHITECTURE.md §15, audit_log).
        await recordAudit(db, tenant, {
          action: "agent.updated",
          targetType: "agent",
          targetId: agent.id,
          data: {
            ...(patch.grants ? { grants: patch.grants } : {}),
            ...(patch.status ? { status: patch.status } : {}),
          },
          ...requestMeta(c),
        });
      }
      await announce(tenant.workspaceId, agent.id);
      return c.json(toAgent(agent));
    })
    .get("/:id/thread", async (c) => {
      const tenant = c.get("tenant");
      const agent = await getAgent(db, tenant, c.req.param("id"));
      if (!agent) throw new NotFoundError("Agent");
      return c.json(toThread(await directThread(db, tenant, agent.id)));
    })
    .get("/:id/threads", async (c) => {
      const tenant = c.get("tenant");
      const query = readQuery(c, threadListQuerySchema);
      const agent = await getAgent(db, tenant, c.req.param("id"));
      if (!agent) throw new NotFoundError("Agent");
      const page = await listDirectThreads(db, tenant, agent.id, {
        limit: query.limit,
        before: query.cursor,
        search: query.q,
        previewChars: THREAD_PREVIEW_CHARS,
      });
      return c.json({
        items: page.items.map(toThreadSummary),
        nextCursor: page.nextCursor,
      } satisfies ThreadSummaryPage);
    })
    .post("/:id/threads", async (c) => {
      const tenant = c.get("tenant");
      const agent = await getAgent(db, tenant, c.req.param("id"));
      if (!agent) throw new NotFoundError("Agent");
      return c.json(toThread(await newDirectThread(db, tenant, agent.id)), 201);
    });
}
