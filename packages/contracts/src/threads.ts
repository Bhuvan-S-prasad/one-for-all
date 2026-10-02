import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { runSchema } from "./runs";

// Conversations between people and agents (ARCHITECTURE.md §6.3, §15).

export const threadKindSchema = z.enum(["direct", "group"]);
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
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
});
export type Thread = z.infer<typeof threadSchema>;

/** One agent makes a direct thread; two or more make a group thread. */
export const createThreadRequestSchema = z.object({
  agentIds: z
    .array(idSchema)
    .min(1)
    .max(MAX_THREAD_AGENTS)
    .refine((ids) => new Set(ids).size === ids.length, "List each agent once"),
  title: z.string().trim().min(1).max(120).optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

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
