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

// ── Episodes (M5.09) ─────────────────────────────────────────────────────────
// What happened in a run and how it ended: one per run that replied. Nightly
// consolidation reads them for new facts and repeated procedures.

export const EPISODE_OUTCOMES = ["done", "stopped", "failed"] as const;

export const episodeSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  runId: idSchema,
  threadId: idSchema.nullable(),
  summary: z.string(),
  outcome: z.enum(EPISODE_OUTCOMES),
  /** The run read outside content; its episode isn't used for new facts. */
  tainted: z.boolean(),
  createdAt: timestampSchema,
});
export type Episode = z.infer<typeof episodeSchema>;

export const episodeListQuerySchema = z.object({
  agentId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const episodeListSchema = z.object({ items: z.array(episodeSchema) });
export type EpisodeList = z.infer<typeof episodeListSchema>;
