import {
  createThreadRequestSchema,
  paginationQuerySchema,
  sendMessageRequestSchema,
  groupThreadListQuerySchema,
  updateThreadRequestSchema,
  type MessagePage,
  type ThreadList,
  type UnreadList,
} from "@ofa/contracts";
import { AppError, NotFoundError } from "@ofa/core";
import {
  createGroupThread,
  getThread,
  listAgents,
  listGroupThreads,
  listMessages,
  markThreadRead,
  newDirectThread,
  unreadThreads,
  updateThread,
} from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toMessage, toThread } from "../lib/mappers";
import { startAgentTurn } from "../lib/turns";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Threads and messages (M2.19):
 *   GET   /api/threads                group chats (M5.04), most recent first (?archived=true)
 *   GET   /api/threads/unread         chats with agent messages not yet seen (M5.11)
 *   POST  /api/threads/:id/read       seen up to now
 *   POST  /api/threads                one agent: a new direct chat; two to six: a group chat
 *   GET   /api/threads/:id
 *   PATCH /api/threads/:id            rename, archive or bring back (UX.13)
 *   GET   /api/threads/:id/messages   newest page first, oldest-first within a page
 *   POST  /api/threads/:id/messages   write to the agent; starts a run and returns at once
 *
 * The API never runs the agent (hard rule 1): it stores the message and the
 * run, emits `agent/message.received`, and the orchestrator takes it from there.
 */
export function threadRoutes(
  deps: Pick<Container, "db" | "sessions" | "bus" | "dispatcher" | "runs" | "logger">,
) {
  const { db } = deps;

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const query = readQuery(c, groupThreadListQuerySchema);
      const threads = await listGroupThreads(db, c.get("tenant"), {
        archived: query.archived === "true",
      });
      return c.json({ items: threads.map(toThread) } satisfies ThreadList);
    })
    .post("/", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, createThreadRequestSchema);
      const known = new Map(
        (await listAgents(db, tenant)).filter((a) => a.status !== "archived").map((a) => [a.id, a]),
      );
      const missing = input.agentIds.filter((id) => !known.has(id));
      if (missing.length > 0) throw new NotFoundError("Agent");
      if (input.agentIds.length === 1) {
        return c.json(toThread(await newDirectThread(db, tenant, input.agentIds[0]!)), 201);
      }
      const coordinator = input.coordinatorAgentId ?? input.agentIds[0]!;
      if (known.get(coordinator)?.status !== "active") {
        throw new AppError("conflict", "The coordinator must be an active agent");
      }
      const thread = await createGroupThread(db, tenant, {
        agentIds: input.agentIds,
        coordinatorAgentId: coordinator,
        title: input.title ?? null,
      });
      return c.json(toThread(thread), 201);
    })
    .get("/unread", async (c) => {
      const rows = await unreadThreads(db, c.get("tenant"));
      return c.json({
        items: rows.map((r) => ({ ...r, lastAt: r.lastAt.toISOString() })),
      } satisfies UnreadList);
    })
    .post("/:id/read", async (c) => {
      const tenant = c.get("tenant");
      const thread = await getThread(db, tenant, c.req.param("id"));
      if (!thread) throw new NotFoundError("Thread");
      await markThreadRead(db, tenant, thread.id);
      return c.body(null, 204);
    })
    .get("/:id", async (c) => {
      const thread = await getThread(db, c.get("tenant"), c.req.param("id"));
      if (!thread) throw new NotFoundError("Thread");
      return c.json(toThread(thread));
    })
    .patch("/:id", async (c) => {
      const patch = await readJson(c, updateThreadRequestSchema);
      const thread = await updateThread(db, c.get("tenant"), c.req.param("id"), patch);
      if (!thread) throw new NotFoundError("Thread");
      return c.json(toThread(thread));
    })
    .get("/:id/messages", async (c) => {
      const tenant = c.get("tenant");
      const query = readQuery(c, paginationQuerySchema);
      const thread = await getThread(db, tenant, c.req.param("id"));
      if (!thread) throw new NotFoundError("Thread");
      const page = await listMessages(db, tenant, thread.id, {
        limit: query.limit,
        before: query.cursor,
      });
      return c.json({
        items: page.items.map(toMessage),
        nextCursor: page.nextCursor,
      } satisfies MessagePage);
    })
    .post("/:id/messages", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, sendMessageRequestSchema);
      const thread = await getThread(db, tenant, c.req.param("id"));
      if (!thread) throw new NotFoundError("Thread");
      return c.json(await startAgentTurn(deps, tenant, thread, input.content), 201);
    });
}
