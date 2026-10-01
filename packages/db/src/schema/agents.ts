import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id, updatedAt } from "./columns";
import { agentStatus } from "./enums";
import { workspaceId } from "./tenancy";

/**
 * Agent spec stored as JSON (ARCHITECTURE.md §6.1). Its zod schema arrives
 * with the agent API in M2; until then it is an open object.
 */
export type AgentSpecJson = Record<string, unknown>;

export const agent = pgTable(
  "agent",
  {
    id: id(),
    workspaceId: workspaceId(),
    /** URL- and mention-friendly name, unique in the workspace (`@researcher`). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    spec: jsonb("spec")
      .$type<AgentSpecJson>()
      .notNull()
      .default(sql`'{}'::jsonb`),
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
