import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { createdAt, id, timestampAt } from "./columns";
import { discussionStatus } from "./enums";
import { message } from "./messages";
import { run } from "./runs";
import { workspaceId } from "./tenancy";
import { thread } from "./threads";

/**
 * A group discussion (ADR-0050): a question the members answer one at a
 * time, in a fixed order, for at most a few rounds, closed by the
 * coordinator. One open discussion per thread.
 */
export const discussion = pgTable(
  "discussion",
  {
    id: id(),
    workspaceId: workspaceId(),
    threadId: uuid("thread_id").notNull(),
    /** The question: the person's message, or the one the coordinator posted. */
    questionMessageId: uuid("question_message_id").notNull(),
    /** The coordinator's run that asked (`ask_group`); null when the person did. */
    startedByRunId: uuid("started_by_run_id"),
    coordinatorAgentId: uuid("coordinator_agent_id").notNull(),
    /** Who takes part, in order. */
    memberIds: uuid("member_ids").array().notNull(),
    rounds: integer("rounds").notNull(),
    /** The round going now (or the last one), 1-based. */
    round: integer("round").notNull().default(1),
    status: discussionStatus("status").notNull().default("active"),
    closingMessageId: uuid("closing_message_id"),
    /** A turn read outside content: every later turn starts tainted (ADR-0013). */
    tainted: boolean("tainted").notNull().default(false),
    createdAt: createdAt(),
    endedAt: timestampAt("ended_at"),
  },
  (t) => [
    foreignKey({
      name: "discussion_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "discussion_coordinator_fk",
      columns: [t.workspaceId, t.coordinatorAgentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "discussion_question_fk",
      columns: [t.questionMessageId],
      foreignColumns: [message.id],
    }).onDelete("cascade"),
    check("discussion_rounds_ck", sql`${t.rounds} between 1 and 3 and ${t.round} between 1 and 3`),
    // One open discussion per thread.
    uniqueIndex("discussion_open_thread_uq")
      .on(t.threadId)
      .where(sql`${t.status} in ('active', 'closing')`),
    index("discussion_thread_created_idx").on(t.threadId, t.createdAt),
  ],
);

/** One turn: the run a member (or, closing, the coordinator) takes it in. */
export const discussionTurn = pgTable(
  "discussion_turn",
  {
    id: id(),
    workspaceId: workspaceId(),
    discussionId: uuid("discussion_id")
      .notNull()
      .references(() => discussion.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    round: integer("round").notNull(),
    /** Its place in the order, 0-based; null for the close. */
    position: integer("position"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "discussion_turn_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [run.workspaceId, run.id],
    }).onDelete("cascade"),
    uniqueIndex("discussion_turn_run_uq").on(t.runId),
    index("discussion_turn_discussion_idx").on(t.discussionId, t.createdAt),
  ],
);
