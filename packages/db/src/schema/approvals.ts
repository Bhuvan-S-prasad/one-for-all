import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, id, timestampAt } from "./columns";
import { policyVerdict } from "./enums";
import { run } from "./runs";
import { workspaceId } from "./tenancy";

/**
 * A tool call waiting for a person (ARCHITECTURE.md §6.2). The run asks,
 * then waits on `approval/decided`; this row is the truth about the answer,
 * so a decision made just before the wait started is not lost. Arguments are
 * stored redacted (hard rule 4).
 */
export const approval = pgTable(
  "approval",
  {
    id: id(),
    workspaceId: workspaceId(),
    runId: uuid("run_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** The step in the run (`tool-3-0`): one approval per call, so a retried step finds its own. */
    toolCallId: text("tool_call_id").notNull(),
    tool: text("tool").notNull(),
    args: jsonb("args").$type<unknown>().notNull(),
    /** What the call would do, in plain words. */
    summary: text("summary").notNull(),
    reasons: jsonb("reasons")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    verdict: policyVerdict("verdict").notNull(),
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    decidedAt: timestampAt("decided_at"),
    expiresAt: timestampAt("expires_at").notNull(),
  },
  (t) => [
    foreignKey({
      name: "approval_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [run.workspaceId, run.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "approval_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    unique("approval_run_call_uq").on(t.runId, t.toolCallId),
    check(
      "approval_status_ck",
      sql`${t.status} in ('pending', 'approved', 'rejected', 'expired')`,
    ),
    index("approval_workspace_status_idx").on(t.workspaceId, t.status, t.createdAt),
  ],
);
