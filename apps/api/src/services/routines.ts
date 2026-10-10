import { ROUTINE_IDLE_PAUSE_DAYS } from "@ofa/contracts";
import type { RoutineRunner, RunStart, TenantContext } from "@ofa/core";
import { fireDueRoutine, startRoutineTestRun, type Database, type DueRoutineRow } from "@ofa/db";
import { randomUUID } from "node:crypto";
import { stableUuid } from "./team";

// Routines on the clock (M5.06, ADR-0035): the orchestrator's routine-tick
// asks for due routines every minute and fires each through here.

/** A due time this late was missed (the server was off) and is skipped, not run late. */
export const ROUTINE_MISSED_AFTER_MS = 60 * 60_000;

export interface RoutineRunnerOptions {
  /** Due routines across workspaces; reads through the owner connection. */
  readonly listDue: (now: Date) => Promise<DueRoutineRow[]>;
  /** Tell open clients a message was posted. */
  readonly announce?: (workspaceId: string, threadId: string, messageId: string) => Promise<void>;
}

export interface RoutineService extends RoutineRunner {
  /** A test run now, outside the schedule; the caller starts it. */
  testRun(ctx: TenantContext, routineId: string): Promise<RunStart | null>;
}

export function createRoutineService(db: Database, options: RoutineRunnerOptions): RoutineService {
  const announce = async (ctx: TenantContext, threadId: string, messageId: string) =>
    options.announce?.(ctx.workspaceId, threadId, messageId).catch(() => {});

  return {
    async listDue(now) {
      return (await options.listDue(now)).map((r) => ({
        workspaceId: r.workspaceId,
        userId: r.userId,
        routineId: r.routineId,
        dueAt: r.dueAt.toISOString(),
      }));
    },

    async fire(ctx, routineId, dueAt, now) {
      const result = await fireDueRoutine(db, ctx, {
        routineId,
        dueAt,
        now,
        // One run per due time, whatever retries the tick makes.
        runId: stableUuid(`${ctx.workspaceId}:routine:${routineId}:${dueAt.toISOString()}`),
        idleSince: new Date(now.getTime() - ROUTINE_IDLE_PAUSE_DAYS * 24 * 60 * 60_000),
        missedAfterMs: ROUTINE_MISSED_AFTER_MS,
      });
      if (result.outcome !== "started") return { outcome: result.outcome, run: null };
      await announce(ctx, result.run.threadId, result.run.messageId);
      return {
        outcome: "started",
        run: {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          ...result.run,
          trigger: "routine",
        },
      };
    },

    async testRun(ctx, routineId) {
      const made = await startRoutineTestRun(db, ctx, { routineId, runId: randomUUID() });
      if (!made) return null;
      await announce(ctx, made.threadId, made.messageId);
      return { workspaceId: ctx.workspaceId, userId: ctx.userId, ...made, trigger: "manual" };
    },
  };
}
