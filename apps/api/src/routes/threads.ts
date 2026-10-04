import {
  paginationQuerySchema,
  sendMessageRequestSchema,
  type MessagePage,
  type SendMessageResponse,
} from "@ofa/contracts";
import { AppError, asId, NotFoundError, type RunId } from "@ofa/core";
import { workspaceEvent } from "@ofa/events";
import { getAgent, getThread, listMessages, startTurn } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toMessage, toRun, toThread } from "../lib/mappers";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Threads and messages (M2.19):
 *   GET  /api/threads/:id
 *   GET  /api/threads/:id/messages   newest page first, oldest-first within a page
 *   POST /api/threads/:id/messages   write to the agent; starts a run and returns at once
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
      const member = thread.members.find((m) => m.type === "agent");
      if (!member || member.type !== "agent")
        throw new AppError("bad_request", "This thread has no agent to answer");
      const agent = await getAgent(db, tenant, member.agentId);
      if (!agent) throw new NotFoundError("Agent");
      if (agent.status !== "active") {
        throw new AppError("conflict", `${agent.name} is ${agent.status}. Resume it to chat.`);
      }

      const turn = await startTurn(db, tenant, {
        threadId: thread.id,
        agentId: agent.id,
        content: input.content,
      });
      await deps.bus
        .publish(
          workspaceEvent(tenant.workspaceId, {
            kind: "message.created",
            threadId: thread.id,
            messageId: turn.message.id,
          }),
        )
        .catch(() => {});

      try {
        await deps.dispatcher.messageReceived({
          workspaceId: tenant.workspaceId,
          userId: tenant.userId,
          agentId: agent.id,
          threadId: thread.id,
          messageId: turn.message.id,
          runId: turn.run.id,
          trigger: "message",
        });
      } catch (error) {
        deps.logger.error("could not start run", { error, runId: turn.run.id });
        await deps.runs.update(tenant, asId<RunId>(turn.run.id), {
          status: "failed",
          error: {
            code: "dispatch_failed",
            message: "The job runner (Inngest) could not be reached",
          },
          endedAt: new Date(),
          onlyIfActive: true,
        });
        throw new AppError(
          "internal",
          "Couldn't start the agent: the job runner is not reachable. Is Inngest running?",
        );
      }

      return c.json(
        { message: toMessage(turn.message), run: toRun(turn.run) } satisfies SendMessageResponse,
        201,
      );
    });
}
