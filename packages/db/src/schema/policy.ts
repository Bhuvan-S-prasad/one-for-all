import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, id, updatedAt } from "./columns";
import { workspaceId } from "./tenancy";

/**
 * A rule for the policy engine (ARCHITECTURE.md §10.2, ADR-0013): ask first
 * before a tool runs, or let it run without asking. `tool` is a tool name, an
 * app wildcard (`gmail.*`) or `*`. A rule may apply to one agent or to all.
 *
 * With no `user_id` it is a workspace rule; with one, that person's own rule.
 * Personal rules can only make workspace rules stricter, so the database
 * refuses a personal allow-auto rule. Rules never loosen the always-human
 * list or taint escalation: the engine applies them after those (§10.2).
 */
export const policyRule = pgTable(
  "policy_rule",
  {
    id: id(),
    workspaceId: workspaceId(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    tool: text("tool").notNull(),
    effect: text("effect").notNull(),
    /** Why the rule exists, in the words of whoever wrote it. */
    description: text("description").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "policy_rule_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    unique("policy_rule_scope_tool_uq")
      .on(t.workspaceId, t.userId, t.agentId, t.tool, t.effect)
      .nullsNotDistinct(),
    index("policy_rule_workspace_idx").on(t.workspaceId, t.enabled),
    check("policy_rule_effect_ck", sql`${t.effect} in ('ask_first', 'allow_auto')`),
    check("policy_rule_personal_ck", sql`${t.userId} is null or ${t.effect} = 'ask_first'`),
    // `*`, `remember`, `gmail.*` or `gmail.send`.
    check("policy_rule_tool_ck", sql`${t.tool} ~ '^(\\*|[a-z][a-z0-9_]*(\\.(\\*|[a-z0-9_]+))?)$'`),
  ],
);
