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
