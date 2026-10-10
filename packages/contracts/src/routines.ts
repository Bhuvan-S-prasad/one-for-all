import { isTimeZone, parseCron } from "@ofa/core";
import { z } from "zod";
import { idSchema, timestampSchema } from "./common";
import { runSchema } from "./runs";

// Routines (M5.06): an agent's standing job on a schedule, such as a morning
// brief. Each run posts in the routine's own chat (ADR-0035).

/** At most this many routines per agent. */
export const ROUTINES_PER_AGENT = 50;
/** Runs listed in a routine's history. */
export const ROUTINE_HISTORY_RUNS = 20;
/** A routine may not run more often than this: free model quotas are small. */
export const ROUTINE_MIN_GAP_MINUTES = 15;
/** Routines pause themselves after their owner has been away this long. */
export const ROUTINE_IDLE_PAUSE_DAYS = 14;

/** An IANA time zone, such as `Europe/Paris`. */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isTimeZone, "Unknown time zone (use a name such as Europe/Paris)");

/** Five fields: minute, hour, day of month, month, day of week (`0 7 * * 1-5`). */
export const cronSchema = z
  .string()
  .trim()
  .min(9)
  .max(100)
  .superRefine((value, ctx) => {
    try {
      parseCron(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
    }
  });

/**
 * `task`: does a job and replies each time. `check`: looks with read-only
 * tools and replies only when something needs attention (M5.10).
 */
export const ROUTINE_KINDS = ["task", "check"] as const;
export const routineKindSchema = z.enum(ROUTINE_KINDS);

export const ROUTINE_STATUSES = ["active", "paused"] as const;
export const routineStatusSchema = z.enum(ROUTINE_STATUSES);

/** `person`: someone paused it; `inactive`: its owner was away (ROUTINE_IDLE_PAUSE_DAYS). */
export const ROUTINE_PAUSE_REASONS = ["person", "inactive"] as const;

export const routineSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  /** The chat each run posts in. */
  threadId: idSchema,
  name: z.string(),
  /** What the agent does each time, in the person's words. */
  instructions: z.string(),
  kind: routineKindSchema,
  cron: z.string(),
  timeZone: z.string(),
  status: routineStatusSchema,
  pausedReason: z.enum(ROUTINE_PAUSE_REASONS).nullable(),
  /** Null while paused. */
  nextRunAt: timestampSchema.nullable(),
  lastRunAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Routine = z.infer<typeof routineSchema>;

export const createRoutineRequestSchema = z.object({
  agentId: idSchema,
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(4_000),
  kind: routineKindSchema.default("task"),
  cron: cronSchema,
  /** Defaults to the workspace's time zone. */
  timeZone: timeZoneSchema.optional(),
});
export type CreateRoutineRequest = z.infer<typeof createRoutineRequestSchema>;

export const updateRoutineRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    instructions: z.string().trim().min(1).max(4_000),
    kind: routineKindSchema,
    cron: cronSchema,
    timeZone: timeZoneSchema,
    /** Pause, or resume (which also clears a pause for inactivity). */
    status: routineStatusSchema,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to change");
export type UpdateRoutineRequest = z.infer<typeof updateRoutineRequestSchema>;

export const routineListQuerySchema = z.object({ agentId: idSchema.optional() });

export const routineListSchema = z.object({ items: z.array(routineSchema) });
export type RoutineList = z.infer<typeof routineListSchema>;

/** A routine's latest runs, newest first (at most ROUTINE_HISTORY_RUNS). */
export const routineRunsSchema = z.object({ items: z.array(runSchema) });
export type RoutineRuns = z.infer<typeof routineRunsSchema>;
