import { SCHEDULES_PER_AGENT, type ScheduleCreatedEvent } from "@ofa/contracts";
import { AppError, type ScheduleRunner, type Scheduler } from "@ofa/core";
import {
  createSchedule,
  fireSchedule,
  getRun,
  getThread,
  getWorkspace,
  type Database,
} from "@ofa/db";
import { stableUuid } from "./team";

// Prospective memory (M5.07, ADR-0035): what `schedule_task` and `remind_me`
// write through, and what the orchestrator's schedule-fire calls when an
// item is due.

export interface SchedulerOptions {
  /** Start the item's wait (the orchestrator's `schedule/item.created`). */
  readonly wake?: (event: ScheduleCreatedEvent) => Promise<void>;
  /** Tell open clients a message was posted. */
  readonly announce?: (workspaceId: string, threadId: string, messageId: string) => Promise<void>;
}

export function createScheduler(
  db: Database,
  options: SchedulerOptions = {},
): Scheduler & ScheduleRunner {
  return {
    async timeZone(ctx) {
      return (await getWorkspace(db, ctx)).timeZone;
    },

    async schedule(ctx, input) {
      if (!options.wake) throw new AppError("internal", "Nothing can be scheduled on this server");
      const run = await getRun(db, ctx, ctx.runId);
      const thread = run?.threadId ? await getThread(db, ctx, run.threadId) : null;
      // Posted or done later in this conversation, which the person must be in.
      if (!run || !thread || thread.kind === "handoff") {
        throw new AppError(
          "bad_request",
          "Nothing can be set for later here: this work was handed over by another agent. Say in your reply what should happen later.",
        );
      }
      const { row } = await createSchedule(db, ctx, {
        agentId: ctx.agentId,
        threadId: thread.id,
        runId: ctx.runId,
        key: input.key,
        kind: input.kind,
        content: input.content,
        dueAt: input.dueAt,
        // A task set after outside content may carry someone else's words (ADR-0013).
        tainted: run.tainted,
        limit: SCHEDULES_PER_AGENT,
      });
      // Sent every time: a retried call still starts the wait, and Inngest
      // drops a second event for the same item.
      await options.wake({
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        scheduleId: row.id,
        dueAt: row.dueAt.toISOString(),
      });
      return { id: row.id, kind: row.kind, content: row.content, dueAt: row.dueAt };
    },

    async fire(ctx, scheduleId, now) {
      const result = await fireSchedule(db, ctx, {
        id: scheduleId,
        now,
        runId: stableUuid(`${ctx.workspaceId}:schedule:${scheduleId}`),
      });
      if (result.outcome === "reminded") {
        await options
          .announce?.(ctx.workspaceId, result.threadId, result.messageId)
          .catch(() => {});
        return { outcome: "reminded", run: null };
      }
      if (result.outcome !== "started") return { outcome: result.outcome, run: null };
      await options
        .announce?.(ctx.workspaceId, result.run.threadId, result.run.messageId)
        .catch(() => {});
      return {
        outcome: "started",
        run: {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          ...result.run,
          trigger: "schedule",
        },
      };
    },
  };
}
