import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, id, timestampAt, updatedAt } from "./columns";
import { episodeOutcome, skillSource, skillStatus } from "./enums";
import { run } from "./runs";
import { workspaceId } from "./tenancy";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Procedural memory (ARCHITECTURE.md §8, M5.08, ADR-0036): how to do a task.
 * Instructions only (ADR-0018). `agent_id` null: every agent may use it.
 * Only `active` skills reach a model; `proposed` ones wait for a person.
 */
export const skill = pgTable(
  "skill",
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid("agent_id"),
    /** `/slug` in a message applies it; unique in the workspace. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    steps: text("steps").array().notNull(),
    status: skillStatus("status").notNull().default("active"),
    source: skillSource("source").notNull(),
    sourceRunId: uuid("source_run_id"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "skill_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "skill_source_run_fk",
      columns: [t.workspaceId, t.sourceRunId],
      foreignColumns: [run.workspaceId, run.id],
    }),
    uniqueIndex("skill_workspace_slug_uq").on(t.workspaceId, t.slug),
    index("skill_workspace_agent_idx").on(t.workspaceId, t.agentId, t.status),
  ],
);

/**
 * Episodic memory (ARCHITECTURE.md §8, M5.09): what one run was asked and
 * how it ended. Written as the run ends; the learning pass replaces the
 * summary with a better one. Nightly consolidation reads the new ones.
 */
export const episode = pgTable(
  "episode",
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid("agent_id").notNull(),
    /** The person the run acted for. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    threadId: uuid("thread_id"),
    summary: text("summary").notNull(),
    outcome: episodeOutcome("outcome").notNull(),
    tainted: boolean("tainted").notNull().default(false),
    summarySearch: tsvector("summary_search").generatedAlwaysAs(
      sql`to_tsvector('english', summary)`,
    ),
    /** Read by nightly consolidation. */
    consolidatedAt: timestampAt("consolidated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "episode_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "episode_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [run.workspaceId, run.id],
    }).onDelete("cascade"),
    uniqueIndex("episode_run_uq").on(t.runId),
    index("episode_workspace_agent_idx").on(t.workspaceId, t.agentId, t.createdAt),
    index("episode_summary_search_idx").using("gin", t.summarySearch),
  ],
);
