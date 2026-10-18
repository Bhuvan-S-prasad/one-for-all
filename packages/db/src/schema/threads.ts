import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, id, timestampAt, updatedAt } from "./columns";
import { participantType, threadKind } from "./enums";
import { workspaceId } from "./tenancy";

/** A conversation: direct (one agent) or group (2–6 agents). */
export const thread = pgTable(
  "thread",
  {
    id: id(),
    workspaceId: workspaceId(),
    kind: threadKind("kind").notNull().default("direct"),
    title: text("title"),
    /** Group threads: answers messages that `@mention` nobody, and routes them (M5.04). */
    coordinatorAgentId: uuid("coordinator_agent_id"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    archivedAt: timestampAt("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("thread_workspace_updated_idx").on(t.workspaceId, t.updatedAt),
    unique("thread_workspace_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      name: "thread_coordinator_fk",
      columns: [t.workspaceId, t.coordinatorAgentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }),
  ],
);

/** A user or an agent in a thread. Exactly one of `user_id` / `agent_id` is set. */
export const threadMember = pgTable(
  "thread_member",
  {
    id: id(),
    workspaceId: workspaceId(),
    threadId: uuid("thread_id").notNull(),
    memberType: participantType("member_type").notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    joinedAt: timestampAt("joined_at").notNull().defaultNow(),
    /** A person's: what they have seen; later agent messages are unread (M5.11). */
    lastReadAt: timestampAt("last_read_at"),
  },
  (t) => [
    foreignKey({
      name: "thread_member_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "thread_member_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    check(
      "thread_member_one_member_ck",
      sql`(${t.memberType} = 'user' and ${t.userId} is not null and ${t.agentId} is null)
       or (${t.memberType} = 'agent' and ${t.agentId} is not null and ${t.userId} is null)`,
    ),
    uniqueIndex("thread_member_user_uq")
      .on(t.threadId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex("thread_member_agent_uq")
      .on(t.threadId, t.agentId)
      .where(sql`${t.agentId} is not null`),
  ],
);

/** An agent's working record in a chat, as JSON (ADR-0045; the shape is `ChatRecord` in core). */
export interface ThreadStateJson {
  plan: { text: string; done: boolean }[] | null;
  ledger: {
    kind: string;
    text: string;
    untrusted?: boolean;
    agent?: string;
    answer?: string;
    runId: string;
  }[];
  notes: string | null;
  stopReason: string | null;
  tainted: boolean;
}

/**
 * Each agent's working record in a chat (ADR-0045): its plan, what it did and
 * its notes, so the next run there carries on instead of starting over. One
 * row per thread and agent, rewritten as each run goes.
 */
export const threadState = pgTable(
  "thread_state",
  {
    id: id(),
    workspaceId: workspaceId(),
    threadId: uuid("thread_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    state: jsonb("state").$type<ThreadStateJson>().notNull(),
    /** The run that last wrote it. */
    runId: uuid("run_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "thread_state_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "thread_state_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    uniqueIndex("thread_state_thread_agent_uq").on(t.threadId, t.agentId),
  ],
);
