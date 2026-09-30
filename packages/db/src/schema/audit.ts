import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { actorType } from "./enums";
import { workspaceId } from "./tenancy";

/**
 * Append-only record of security-relevant actions: setup, logins, grants,
 * approvals, policy changes. Actor IDs are plain values, not foreign keys, so
 * entries outlive the users and agents they mention.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    workspaceId: workspaceId(),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    /** `noun.verb`, e.g. `workspace.created`, `session.created`. */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);
