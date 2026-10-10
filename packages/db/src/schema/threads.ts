import { sql } from "drizzle-orm";
import {
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
