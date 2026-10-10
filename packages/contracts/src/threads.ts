import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { runSchema } from "./runs";

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

export const sendMessageRequestSchema = z.object({
  content: z.string().trim().min(1, "Write a message").max(MAX_MESSAGE_LENGTH),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

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
