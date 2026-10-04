import { MEMORY_KINDS, MEMORY_SCOPES } from "@ofa/core";
import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

// What agents learned, for people to review (UX.14, ARCHITECTURE.md §8).
// Facts learned while reading outside content are stored unverified and are
// not used until a person confirms them.

export const memoryItemSchema = z.object({
  id: idSchema,
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS),
  /** Null for workspace facts, which every agent shares. */
  agentId: idSchema.nullable(),
  content: z.string(),
  verified: z.boolean(),
  /** The run that learned it, if any. */
  sourceRunId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const memoryListQuerySchema = z.object({
  agentId: idSchema.optional(),
  runId: idSchema.optional(),
  /** `false`: only facts waiting for a person to confirm them. */
  verified: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;

export const memoryListSchema = z.object({ items: z.array(memoryItemSchema) });
export type MemoryList = z.infer<typeof memoryListSchema>;
