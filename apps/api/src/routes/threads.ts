import {
  createThreadRequestSchema,
  paginationQuerySchema,
  sendMessageRequestSchema,
  groupThreadListQuerySchema,
  MAX_UPLOAD_BYTES,
  updateThreadRequestSchema,
  CONVERSATION_SNIPPET_CHARS,
  type ConversationList,
  type DiscussionList,
  type MessagePage,
  type ThreadList,
  type UnreadList,
} from "@ofa/contracts";
import { AppError, MAX_ARTIFACT_BYTES, NotFoundError } from "@ofa/core";
import {
  attachmentLine,
  attachUploads,
  createGroupThread,
  createUpload,
  getThread,
  listAgents,
  listDiscussions,
  listConversations,
  listGroupThreads,
  listMessages,
  markThreadRead,
  newDirectThread,
  sendableUploads,
  unreadThreads,
  updateThread,
} from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toDiscussion, toMessage, toThread, toUpload } from "../lib/mappers";
import { startAgentTurn } from "../lib/turns";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Threads and messages (M2.19):
 *   GET   /api/threads                group chats (M5.04), most recent first (?archived=true)
 *   GET   /api/threads/unread         chats with agent messages not yet seen (M5.11)
 *   GET   /api/threads/conversations  the sidebar: each agent's latest chat and each group, with the last message (ADR-0052)
 *   POST  /api/threads/:id/read       seen up to now
 *   POST  /api/threads                one agent: a new direct chat; two to six: a group chat
 *   GET   /api/threads/:id
 *   PATCH /api/threads/:id            rename, archive or bring back (UX.13)
 *   GET   /api/threads/:id/messages   newest page first, oldest-first within a page
 *   POST  /api/threads/:id/uploads    attach a file (raw bytes; ?name=&type=), sent with the next message (EN.09)
 *   POST  /api/threads/:id/messages   write to the agent; starts a run and returns at once
 *   GET   /api/threads/:id/discussions  a group's discussions, newest first, with their turns (ADR-0050)
 *
 * The API never runs the agent (hard rule 1): it stores the message and the
 * run, emits `agent/message.received`, and the orchestrator takes it from there.
 */
export function threadRoutes(
  deps: Pick<
    Container,
    "db" | "blobs" | "sessions" | "bus" | "dispatcher" | "runs" | "logger" | "discussions"
  >,
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
    .get("/conversations", async (c) => {
      const rows = await listConversations(db, c.get("tenant"), {
        snippetChars: CONVERSATION_SNIPPET_CHARS,
      });
      return c.json({
        items: rows.map((r) => ({
          ...r,
          last: r.last ? { ...r.last, at: r.last.at.toISOString() } : null,
          activeAt: r.activeAt.toISOString(),
        })),
      } satisfies ConversationList);
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
    .get("/:id/discussions", async (c) => {
      const tenant = c.get("tenant");
      const thread = await getThread(db, tenant, c.req.param("id"));
      if (!thread) throw new NotFoundError("Thread");
      const rows = await listDiscussions(db, tenant, thread.id);
      return c.json({ items: rows.map(toDiscussion) } satisfies DiscussionList);
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
    .post("/:id/uploads", async (c) => {
      const tenant = c.get("tenant");
      const thread = await getThread(db, tenant, c.req.param("id"));
      if (!thread) throw new NotFoundError("Thread");
      if (thread.kind === "handoff") {
        throw new AppError("bad_request", "This thread is between agents; attach files in a chat");
      }
      // The bytes stream straight to storage (ADR-0047): never held whole here.
      const size = Number(c.req.header("content-length"));
      if (!Number.isInteger(size) || size < 1) {
        throw new AppError("bad_request", "Send the file with its Content-Length");
      }
      const limit = deps.blobs ? MAX_UPLOAD_BYTES : MAX_ARTIFACT_BYTES;
      if (size > limit) {
        throw new AppError(
          "bad_request",
          `That file is larger than ${deps.blobs ? "2 GB" : "10 MB (this server has no object store)"}`,
        );
      }
      const body = c.req.raw.body;
      if (!body) throw new AppError("bad_request", "No file was sent");
      const row = await createUpload(db, deps.blobs, tenant, {
        threadId: thread.id,
        name: uploadName(c.req.query("name")),
        mimeType: uploadType(c.req.query("type")),
        size,
        body,
      });
      return c.json(toUpload(row), 201);
    })
    .post("/:id/messages", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, sendMessageRequestSchema);
      const thread = await getThread(db, tenant, c.req.param("id"));
      if (!thread) throw new NotFoundError("Thread");
      // Attached files become lines in the message (EN.09): the agent reads
      // them in its history and copies one in with files.receive.
      const uploads = await sendableUploads(db, tenant, {
        threadId: thread.id,
        ids: input.uploads,
      });
      if (uploads.length !== input.uploads.length) {
        throw new AppError("bad_request", "An attached file is missing or was already sent");
      }
      const content = [input.content, ...uploads.map(attachmentLine)].filter(Boolean).join("\n\n");
      const sent = await startAgentTurn(deps, tenant, thread, content);
      if (uploads.length > 0) {
        await attachUploads(db, tenant, {
          threadId: thread.id,
          messageId: sent.message.id,
          ids: uploads.map((u) => u.id),
        });
      }
      return c.json(sent, 201);
    });
}

/** A file name as the person's computer gave it, made safe to show and store. */
function uploadName(value: string | undefined): string {
  const name = (value ?? "")
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    .replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
    .trim()
    .slice(0, 255);
  return name || "file";
}

/** The browser's type for the file, if it looks like one; else plain bytes. */
function uploadType(value: string | undefined): string {
  const type = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type) && type.length <= 100
    ? type
    : "application/octet-stream";
}
