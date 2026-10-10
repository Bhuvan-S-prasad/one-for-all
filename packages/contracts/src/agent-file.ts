import { z } from "zod";
import { agentSchema, createAgentRequestSchema } from "./agents";
import { timestampSchema } from "./common";
import { cronSchema, routineKindSchema, timeZoneSchema } from "./routines";
import { skillSlugSchema } from "./skills";

// An agent as a file (M5.12, ARCHITECTURE.md §6.1): its spec, standing
// rules, grants, own skills and routines. Never its sign-ins, secrets,
// memory or chats. Importing makes a new agent; its skills arrive proposed
// and its routines paused, for a person to review (ADR-0036).

export const AGENT_FILE_FORMAT = "one-for-all/agent";
export const AGENT_FILE_VERSION = 1;

export const agentFileSkillSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: skillSlugSchema,
  description: z.string().trim().min(5).max(500),
  steps: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
});

export const agentFileRoutineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(4_000),
  kind: routineKindSchema.default("task"),
  cron: cronSchema,
  /** Left out: the importing workspace's own. */
  timeZone: timeZoneSchema.optional(),
});

export const agentFileSchema = z.object({
  format: z.literal(AGENT_FILE_FORMAT),
  version: z.literal(AGENT_FILE_VERSION),
  exportedAt: timestampSchema.optional(),
  /** As when hatching one: name, handle, standing rules, spec and grants. */
  agent: createAgentRequestSchema,
  skills: z.array(agentFileSkillSchema).max(50).default([]),
  routines: z.array(agentFileRoutineSchema).max(50).default([]),
});
export type AgentFile = z.infer<typeof agentFileSchema>;
/** What a file holds before defaults are filled in. */
export type AgentFileInput = z.input<typeof agentFileSchema>;

export const importAgentResponseSchema = z.object({
  agent: agentSchema,
  /** Skills it brought, waiting for approval. */
  skills: z.number().int().min(0),
  /** Routines it brought, paused. */
  routines: z.number().int().min(0),
  /** What changed on the way in, such as a handle already in use. */
  notes: z.array(z.string()),
});
export type ImportAgentResponse = z.infer<typeof importAgentResponseSchema>;
