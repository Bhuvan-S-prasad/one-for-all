import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

// Prospective memory (M5.07): what an agent set for later. A reminder is
// posted as it was written; a task wakes the agent to do it (ADR-0035).

/** Pending items per agent, at most. */
export const SCHEDULES_PER_AGENT = 50;
/** How far ahead an item may be set. */
export const SCHEDULE_MAX_AHEAD_DAYS = 366;

export const SCHEDULE_KINDS = ["task", "reminder"] as const;
export const scheduleKindSchema = z.enum(SCHEDULE_KINDS);

export const SCHEDULE_STATUSES = ["pending", "done", "cancelled", "failed"] as const;
export const scheduleStatusSchema = z.enum(SCHEDULE_STATUSES);

export const scheduleSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  /** Where it is posted, or where the task's run replies. */
  threadId: idSchema,
  kind: scheduleKindSchema,
  content: z.string(),
  dueAt: timestampSchema,
  status: scheduleStatusSchema,
  /** The run that set it. */
  runId: idSchema.nullable(),
  /** The task's own run, once it was due. */
  firedRunId: idSchema.nullable(),
  firedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleListQuerySchema = z.object({
  agentId: idSchema.optional(),
  status: scheduleStatusSchema.optional(),
});

export const scheduleListSchema = z.object({ items: z.array(scheduleSchema) });
export type ScheduleList = z.infer<typeof scheduleListSchema>;
