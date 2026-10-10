import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

export { skillSlug } from "@ofa/core";

// Skills (M5.08, ADR-0036): procedural memory. A skill is instructions only
// (ADR-0018): when to use it and the steps to follow, written by a person, by
// an agent after doing the work, or proposed by nightly consolidation.

/** Per workspace, at most. */
export const SKILLS_PER_WORKSPACE = 200;
export const SKILL_STEPS_MAX = 20;

export const SKILL_STATUSES = ["active", "proposed", "archived"] as const;
export const skillStatusSchema = z.enum(SKILL_STATUSES);

/** Who wrote it: a person, an agent with `save_skill`, or nightly consolidation. */
export const SKILL_SOURCES = ["person", "agent", "consolidation"] as const;

/** A handle for `/name` in a message: lower case, digits and dashes. */
export const skillSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,59}$/, "Use lower-case letters, digits and dashes");

export const skillSchema = z.object({
  id: idSchema,
  /** Null: every agent may use it. */
  agentId: idSchema.nullable(),
  slug: z.string(),
  name: z.string(),
  /** When to use it. */
  description: z.string(),
  steps: z.array(z.string()),
  status: skillStatusSchema,
  source: z.enum(SKILL_SOURCES),
  /** The run it was saved from, if an agent saved it. */
  sourceRunId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Skill = z.infer<typeof skillSchema>;

const stepsSchema = z.array(z.string().trim().min(1).max(500)).min(1).max(SKILL_STEPS_MAX);

export const createSkillRequestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Derived from the name when left out. */
  slug: skillSlugSchema.optional(),
  description: z.string().trim().min(5).max(500),
  steps: stepsSchema,
  /** Leave out for a skill every agent may use. */
  agentId: idSchema.optional(),
});
export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>;

export const updateSkillRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().min(5).max(500),
    steps: stepsSchema,
    /** `active` approves a proposed skill; `archived` retires one. */
    status: skillStatusSchema,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change");
export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>;

export const skillListQuerySchema = z.object({
  /** One agent's skills and the shared ones. */
  agentId: idSchema.optional(),
  status: skillStatusSchema.optional(),
});

export const skillListSchema = z.object({ items: z.array(skillSchema) });
export type SkillList = z.infer<typeof skillListSchema>;
