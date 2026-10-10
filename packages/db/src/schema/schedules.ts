import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, id, timestampAt, updatedAt } from "./columns";
import { routineKind, routineStatus, scheduleKind, scheduleStatus } from "./enums";
import { workspaceId } from "./tenancy";
import { thread } from "./threads";

/**
 * An agent's standing job on a schedule (M5.06, ADR-0035). The routine-tick
 * function starts a run when `next_run_at` comes; each run posts in the
 * routine's own chat and acts as its owner (`created_by`).
 */
export const routine = pgTable(
  "routine",
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid("agent_id").notNull(),
    threadId: uuid("thread_id").notNull(),
    name: text("name").notNull(),
    instructions: text("instructions").notNull(),
    /** `check`: read-only tools, and a reply only when something needs attention (M5.10). */
    kind: routineKind("kind").notNull().default("task"),
    /** Five-field cron, read in `time_zone`. */
    cron: text("cron").notNull(),
    timeZone: text("time_zone").notNull(),
    status: routineStatus("status").notNull().default("active"),
    /** `person` or `inactive` (its owner was away), while paused. */
    pausedReason: text("paused_reason"),
    /** Null while paused. */
    nextRunAt: timestampAt("next_run_at"),
    lastRunAt: timestampAt("last_run_at"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "routine_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "routine_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }).onDelete("cascade"),
    check(
      "routine_paused_reason_ck",
      sql`${t.pausedReason} is null or ${t.pausedReason} in ('person', 'inactive')`,
    ),
    index("routine_due_idx").on(t.status, t.nextRunAt),
    index("routine_workspace_agent_idx").on(t.workspaceId, t.agentId),
    unique("routine_workspace_id_uq").on(t.workspaceId, t.id),
  ],
);

/**
 * Prospective memory (ARCHITECTURE.md §8, M5.07): a task or reminder an
 * agent set for later. The schedule-fire function sleeps until `due_at`;
 * the row is the truth, so a cancelled item never fires.
 */
export const schedule = pgTable(
  "schedule",
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid("agent_id").notNull(),
    /** The person the run that set it acted for; the task's run acts as them too. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull(),
    /** The run that set it. */
    runId: uuid("run_id"),
    /** The setting tool call's idempotency key: a retried call sets one item. */
    key: text("key").notNull(),
    kind: scheduleKind("kind").notNull(),
    content: text("content").notNull(),
    dueAt: timestampAt("due_at").notNull(),
    status: scheduleStatus("status").notNull().default("pending"),
    /** Set by a run that had read outside content: the task's run starts tainted (ADR-0013). */
    tainted: boolean("tainted").notNull().default(false),
    firedRunId: uuid("fired_run_id"),
    firedAt: timestampAt("fired_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "schedule_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "schedule_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }).onDelete("cascade"),
    uniqueIndex("schedule_workspace_key_uq").on(t.workspaceId, t.key),
    index("schedule_agent_status_idx").on(t.workspaceId, t.agentId, t.status, t.dueAt),
  ],
);
