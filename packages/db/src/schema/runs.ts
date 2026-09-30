import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, id, timestampAt } from "./columns";
import { runStatus, runTrigger } from "./enums";
import { workspaceId } from "./tenancy";
import { thread } from "./threads";

/** Token and cost totals for a run, filled in by the model gateway (M2). */
export interface RunUsageJson {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  modelCalls?: number;
  toolCalls?: number;
}

/**
 * One execution of an agent (ADR-0014). The run is the unit of truth: its
 * events are the activity feed, trace, audit trail and recovery log.
 */
export const run = pgTable(
  "run",
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid("agent_id").notNull(),
    threadId: uuid("thread_id"),
    /** Set when this run was delegated by another run (M5). */
    parentRunId: uuid("parent_run_id"),
    trigger: runTrigger("trigger").notNull(),
    status: runStatus("status").notNull().default("queued"),
    /** Set once the run reads untrusted content (ADR-0013). Never cleared. */
    tainted: boolean("tainted").notNull().default(false),
    triggeredBy: text("triggered_by").references(() => user.id, { onDelete: "set null" }),
    usage: jsonb("usage")
      .$type<RunUsageJson>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: jsonb("error").$type<{ code: string; message: string }>(),
    createdAt: createdAt(),
    startedAt: timestampAt("started_at"),
    endedAt: timestampAt("ended_at"),
  },
  (t) => [
    foreignKey({
      name: "run_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }),
    foreignKey({
      name: "run_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }),
    foreignKey({
      name: "run_parent_fk",
      columns: [t.workspaceId, t.parentRunId],
      foreignColumns: [t.workspaceId, t.id],
    }),
    index("run_workspace_agent_created_idx").on(t.workspaceId, t.agentId, t.createdAt),
    index("run_thread_idx").on(t.threadId),
    unique("run_workspace_id_uq").on(t.workspaceId, t.id),
  ],
);

/**
 * Append-only run log (hard rule 7). `seq` orders events within a run.
 * A trigger rejects UPDATE and app-role DELETE (0001_row_level_security.sql).
 */
export const runEvent = pgTable(
  "run_event",
  {
    id: id(),
    workspaceId: workspaceId(),
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    /** e.g. `model.called`, `tool.called`, `policy.decided`, `approval.decided`. */
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "run_event_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [run.workspaceId, run.id],
    }),
    unique("run_event_run_seq_uq").on(t.runId, t.seq),
  ],
);
