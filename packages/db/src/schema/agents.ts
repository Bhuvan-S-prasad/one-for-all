import type { AgentSpec } from "@ofa/contracts";
import { foreignKey, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id, updatedAt } from "./columns";
import { agentStatus, grantMode } from "./enums";
import { workspaceId } from "./tenancy";

/**
 * Agent spec stored as JSON (ARCHITECTURE.md §6.1): job, tier, autonomy,
 * voice, familiar, memory scopes, budgets. `agentSpecSchema` in
 * `@ofa/contracts` validates it on the way in and out.
 */
export type AgentSpecJson = AgentSpec;

export const agent = pgTable(
  "agent",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** URL- and mention-friendly name, unique in the workspace (`@researcher`). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    spec: jsonb("spec").$type<AgentSpecJson>().notNull(),
    status: agentStatus("status").notNull().default("active"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agent_workspace_slug_uq").on(t.workspaceId, t.slug),
    // Target for composite foreign keys that keep references inside one workspace.
    unique("agent_workspace_id_uq").on(t.workspaceId, t.id),
  ],
);

/**
 * Which tools an agent may use and how (ARCHITECTURE.md §9.1). `tool` is a
 * tool name or an app wildcard (`hubspot.*`). No row means not granted.
 */
export const agentGrant = pgTable(
  "agent_grant",
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid("agent_id").notNull(),
    tool: text("tool").notNull(),
    mode: grantMode("mode").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "agent_grant_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    uniqueIndex("agent_grant_agent_tool_uq").on(t.agentId, t.tool),
  ],
);
