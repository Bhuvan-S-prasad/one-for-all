import { ARTIFACT_KINDS } from "@ofa/core";
import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

// What runs produce (M3.06): long tool output and files agents wrote.
// Content is fetched separately, always as a download.

export const artifactSchema = z.object({
  id: idSchema,
  runId: idSchema,
  agentId: idSchema,
  kind: z.enum(ARTIFACT_KINDS),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().min(0),
  /** The content came from outside the system. */
  untrusted: z.boolean(),
  createdAt: timestampSchema,
});
export type Artifact = z.infer<typeof artifactSchema>;

export const artifactListSchema = z.object({ items: z.array(artifactSchema) });
export type ArtifactList = z.infer<typeof artifactListSchema>;

/**
 * One piece of work a run handed to another agent (ADR-0032), as the person
 * sees it under the reply: who, the brief, how it ended, the answer, and the
 * files it made. Its own steps are the child run's events.
 */
export const handoffSchema = z.object({
  childRunId: idSchema,
  agentId: idSchema,
  agentName: z.string(),
  /** Still working, or how the delegating run was told it ended. */
  status: z.enum(["working", "done", "stopped", "failed", "cancelled"]),
  brief: z.string().nullable(),
  reply: z.string().nullable(),
  files: z.array(artifactSchema),
});
export type Handoff = z.infer<typeof handoffSchema>;

export const handoffListSchema = z.object({ items: z.array(handoffSchema) });
export type HandoffList = z.infer<typeof handoffListSchema>;
