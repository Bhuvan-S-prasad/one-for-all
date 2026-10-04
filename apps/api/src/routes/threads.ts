import {
  paginationQuerySchema,
  sendMessageRequestSchema,
  updateThreadRequestSchema,
  type MessagePage,
} from "@ofa/contracts";
import { NotFoundError } from "@ofa/core";
import { getThread, listMessages, updateThread } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toMessage, toThread } from "../lib/mappers";
import { startAgentTurn } from "../lib/turns";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Threads and messages (M2.19):
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
