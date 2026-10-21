import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { runSchema, runStatusSchema } from "./runs";

// Conversations between people and agents (ARCHITECTURE.md Â§6.3, Â§15).

/** `handoff`: one agent handed work to another (M5.01); the brief, then the reply. */
export const threadKindSchema = z.enum(["direct", "group", "handoff"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

/** Group threads hold two to six agents. */
export const MAX_THREAD_AGENTS = 6;

export const threadMemberSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: idSchema }),
  z.object({ type: z.literal("agent"), agentId: idSchema }),
]);
export type ThreadMember = z.infer<typeof threadMemberSchema>;

export const threadSchema = z.object({
  id: idSchema,
  kind: threadKindSchema,
  title: z.string().nullable(),
  members: z.array(threadMemberSchema),
  /**
   * In a group thread, the agent that answers a message nobody was
   * `@mentioned` in, and routes it if another member should (M5.04).
   */
  coordinatorAgentId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
});
export type Thread = z.infer<typeof threadSchema>;

/**
 * One agent makes a direct thread; two or more make a group thread, with a
 * coordinator (the first agent unless one is named).
 */
export const createThreadRequestSchema = z
  .object({
    agentIds: z
      .array(idSchema)
      .min(1)
      .max(MAX_THREAD_AGENTS)
      .refine((ids) => new Set(ids).size === ids.length, "List each agent once"),
    title: z.string().trim().min(1).max(120).optional(),
    coordinatorAgentId: idSchema.optional(),
  })
  .refine((v) => v.coordinatorAgentId === undefined || v.agentIds.includes(v.coordinatorAgentId), {
    message: "The coordinator must be one of the agents",
    path: ["coordinatorAgentId"],
  });
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

/** `GET /api/threads`: the person's group chats, or the archived ones. */
export const groupThreadListQuerySchema = z.object({
  kind: z.literal("group").default("group"),
  archived: z.enum(["true", "false"]).optional(),
});

export const threadListSchema = z.object({ items: z.array(threadSchema) });
export type ThreadList = z.infer<typeof threadListSchema>;

export const messageAuthorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: idSchema.nullable() }),
  z.object({ type: z.literal("agent"), agentId: idSchema }),
  z.object({ type: z.literal("system") }),
]);
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

/** Long enough for a pasted document; anything bigger belongs in a file. */
export const MAX_MESSAGE_LENGTH = 20_000;

export const messageSchema = z.object({
  id: idSchema,
  threadId: idSchema,
  author: messageAuthorSchema,
  content: z.string(),
  /** The run that wrote this message, or the run it started. */
  runId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type Message = z.infer<typeof messageSchema>;

/** Files attached to one message at most (EN.09). */
export const MAX_UPLOADS_PER_MESSAGE = 10;

export const sendMessageRequestSchema = z
  .object({
    content: z.string().trim().max(MAX_MESSAGE_LENGTH).default(""),
    /** Files uploaded to this chat first (`POST /api/threads/:id/uploads`), sent with the message. */
    uploads: z.array(idSchema).max(MAX_UPLOADS_PER_MESSAGE).default([]),
  })
  .refine((m) => m.content.length > 0 || m.uploads.length > 0, {
    message: "Write a message",
    path: ["content"],
  });
export type SendMessageRequest = z.input<typeof sendMessageRequestSchema>;

/** A file a person attached to a chat (EN.09). */
export const uploadSchema = z.object({
  id: idSchema,
  threadId: idSchema,
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: timestampSchema,
});
export type Upload = z.infer<typeof uploadSchema>;

/** Largest file a person can attach: 2 GB with an object store, else 10 MB (ADR-0047). */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 - 1;

/** The stored message and the run it started (null when no agent answers). */
export const sendMessageResponseSchema = z.object({
  message: messageSchema,
  run: runSchema.nullable(),
});
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

// â”€â”€ Chat history (UX.13) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Length of the first-message preview in a chat list. */
export const THREAD_PREVIEW_CHARS = 160;

/** A chat in an agent's history: the thread plus what it is about. */
export const threadSummarySchema = threadSchema.extend({
  /** The start of the first message the person wrote; null for an empty chat. */
  preview: z.string().max(THREAD_PREVIEW_CHARS).nullable(),
  messageCount: z.number().int().min(0),
  lastMessageAt: timestampSchema.nullable(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** Rename a chat, or archive it (and bring it back). */
export const updateThreadRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(120).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.archived !== undefined, "Nothing to change");
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

// ── Unread (M5.11) ───────────────────────────────────────────────────────────

/** A chat with agent messages the person hasn't seen. */
export const unreadThreadSchema = z.object({
  threadId: idSchema,
  kind: threadKindSchema,
  /** Its agents: a direct chat's one, or a group's members. */
  agentIds: z.array(idSchema),
  unread: z.number().int().min(1),
  lastAt: timestampSchema,
});
export type UnreadThread = z.infer<typeof unreadThreadSchema>;

export const unreadListSchema = z.object({ items: z.array(unreadThreadSchema) });
export type UnreadList = z.infer<typeof unreadListSchema>;

// ── Discussions (ADR-0050) ───────────────────────────────────────────────────

/** `closing`: the coordinator is writing the answer. */
export const DISCUSSION_STATUSES = ["active", "closing", "done", "stopped", "failed"] as const;
export const discussionStatusSchema = z.enum(DISCUSSION_STATUSES);
export type DiscussionStatus = z.infer<typeof discussionStatusSchema>;

/** One turn of a discussion: a member's, or the coordinator's close. */
export const discussionTurnRecordSchema = z.object({
  runId: idSchema,
  agentId: idSchema,
  round: z.number().int().min(1),
  /** Its place in the order, 0-based; null for the close. */
  position: z.number().int().min(0).nullable(),
  close: z.boolean(),
  status: runStatusSchema,
  /** What it posted; null while it works, and for a pass. */
  messageId: idSchema.nullable(),
});
export type DiscussionTurnRecord = z.infer<typeof discussionTurnRecordSchema>;

export const discussionSchema = z.object({
  id: idSchema,
  threadId: idSchema,
  /** The question: the person's message, or the coordinator's. */
  questionMessageId: idSchema,
  coordinatorAgentId: idSchema,
  /** Who takes part, in order. */
  memberIds: z.array(idSchema),
  rounds: z.number().int().min(1),
  /** The round going now (or the last one), 1-based. */
  round: z.number().int().min(1),
  status: discussionStatusSchema,
  /** The coordinator's agreed answer, once it closed. */
  closingMessageId: idSchema.nullable(),
  tainted: z.boolean(),
  createdAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  turns: z.array(discussionTurnRecordSchema),
});
export type Discussion = z.infer<typeof discussionSchema>;

export const discussionListSchema = z.object({ items: z.array(discussionSchema) });
export type DiscussionList = z.infer<typeof discussionListSchema>;
