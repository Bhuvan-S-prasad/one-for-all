import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, id } from "./columns";
import { actorType } from "./enums";
import { run } from "./runs";
import { workspaceId } from "./tenancy";
import { thread } from "./threads";

/** A message in a thread, written by a user, an agent or the system. */
export const message = pgTable(
  "message",
  {
    id: id(),
    workspaceId: workspaceId(),
    threadId: uuid("thread_id").notNull(),
    authorType: actorType("author_type").notNull(),
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id"),
    content: text("content").notNull(),
    /** The run that produced this message (agent replies) or that it started. */
    runId: uuid("run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "message_thread_fk",
      columns: [t.workspaceId, t.threadId],
      foreignColumns: [thread.workspaceId, thread.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_author_agent_fk",
      columns: [t.workspaceId, t.authorAgentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }),
    foreignKey({
      name: "message_run_fk",
      columns: [t.workspaceId, t.runId],
      foreignColumns: [run.workspaceId, run.id],
    }),
    check(
      "message_agent_author_ck",
      sql`${t.authorType} <> 'agent' or ${t.authorAgentId} is not null`,
    ),
    index("message_thread_created_idx").on(t.threadId, t.createdAt),
  ],
);
