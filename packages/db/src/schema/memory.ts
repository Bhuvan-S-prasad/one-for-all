import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { agent } from "./agents";
import { user } from "./auth";
import { createdAt, embedding, id, timestampAt, updatedAt } from "./columns";
import { memoryKind, memoryScope } from "./enums";
import { run } from "./runs";
import { workspaceId } from "./tenancy";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Semantic memory: facts and preferences (ARCHITECTURE.md §8). Scope decides
 * who sees a row:
 * - `workspace`: everyone's agents (no agent, no user)
 * - `agent`: one agent (agent set, no user)
 * - `agent_user`: one agent's private notes about one person (both set)
 *
 * Facts learned in a tainted run are stored with `verified = false` and are
 * not preloaded until the user confirms them.
 */
export const memory = pgTable(
  "memory",
  {
    id: id(),
    workspaceId: workspaceId(),
    scope: memoryScope("scope").notNull(),
    kind: memoryKind("kind").notNull().default("fact"),
    agentId: uuid("agent_id"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /** Full-text index of `content`: recall works with no embedding model at all. */
    contentSearch: tsvector("content_search").generatedAlwaysAs(
      sql`to_tsvector('english', content)`,
    ),
    embedding: embedding("embedding"),
    /** `provider:model` that produced `embedding`; re-embedded when it changes. */
    embeddingModel: text("embedding_model"),
    verified: boolean("verified").notNull().default(false),
    /** The run that learned this, if any. */
    sourceRunId: uuid("source_run_id"),
    expiresAt: timestampAt("expires_at"),
    lastRecalledAt: timestampAt("last_recalled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "memory_agent_fk",
      columns: [t.workspaceId, t.agentId],
      foreignColumns: [agent.workspaceId, agent.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "memory_source_run_fk",
      columns: [t.workspaceId, t.sourceRunId],
      foreignColumns: [run.workspaceId, run.id],
    }).onDelete("set null"),
    check(
      "memory_scope_owner_ck",
      sql`(${t.scope} = 'workspace' and ${t.agentId} is null and ${t.userId} is null)
       or (${t.scope} = 'agent' and ${t.agentId} is not null and ${t.userId} is null)
       or (${t.scope} = 'agent_user' and ${t.agentId} is not null and ${t.userId} is not null)`,
    ),
    check(
      "memory_embedding_model_ck",
      sql`(${t.embedding} is null) = (${t.embeddingModel} is null)`,
    ),
    index("memory_workspace_scope_agent_idx").on(t.workspaceId, t.scope, t.agentId),
    index("memory_content_search_idx").using("gin", t.contentSearch),
  ],
);
