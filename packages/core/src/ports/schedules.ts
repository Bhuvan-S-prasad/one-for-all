import type { RunContext, TenantContext } from "../tenant";

// Work on the clock (ARCHITECTURE.md §8 prospective memory, M5.06–07):
// routines on a schedule, and tasks and reminders an agent set for later.
// The orchestrator keeps the time; these ports read and write the rows.

/** A run the orchestrator should start (as `agent/message.received`). */
export interface RunStart {
  readonly workspaceId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  /** The request message the run answers. */
  readonly messageId: string;
  readonly runId: string;
  readonly trigger: "routine" | "manual" | "schedule";
}

/** A routine whose next time has come. */
export interface DueRoutine {
  readonly workspaceId: string;
  /** Its owner: runs act as this person. */
  readonly userId: string;
  readonly routineId: string;
  /** The time it was due (ISO 8601). */
  readonly dueAt: string;
}

/**
 * What became of one due time: a run started, or it was passed over because
 * the last run is still going, the time was missed (the server was off), the
 * owner has been away (the routine paused itself), or the agent is paused.
 */
export type RoutineOutcome = "started" | "busy" | "missed" | "paused" | "agent_inactive" | "gone";

export interface RoutineRunner {
  /** Due routines across workspaces, oldest first. */
  listDue(now: Date): Promise<DueRoutine[]>;
  /** Start this due time's run, or pass it over, and move the routine to its next time. */
  fire(
    ctx: TenantContext,
    routineId: string,
    dueAt: Date,
    now: Date,
  ): Promise<{ readonly outcome: RoutineOutcome; readonly run: RunStart | null }>;
}

export type ScheduleKind = "task" | "reminder";

export interface ScheduledItem {
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly content: string;
  readonly dueAt: Date;
}

/** What an agent's `schedule_task` and `remind_me` write through. */
export interface Scheduler {
  /** The time zone clock times are read in: the workspace's. */
  timeZone(ctx: TenantContext): Promise<string>;
  /**
   * Keep an item for later and start its wait. `key` is the tool call's
   * idempotency key, so a retried call sets one item.
   */
  schedule(
    ctx: RunContext,
    input: {
      readonly key: string;
      readonly kind: ScheduleKind;
      readonly content: string;
      readonly dueAt: Date;
    },
  ): Promise<ScheduledItem>;
}

/**
 * A due item: a reminder was posted, a task's run should start, or it had
 * been cancelled (or done) meanwhile.
 */
export type ScheduleOutcome = "reminded" | "started" | "cancelled" | "agent_inactive";

export interface ScheduleRunner {
  fire(
    ctx: TenantContext,
    scheduleId: string,
    now: Date,
  ): Promise<{ readonly outcome: ScheduleOutcome; readonly run: RunStart | null }>;
}
