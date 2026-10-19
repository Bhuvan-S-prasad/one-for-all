import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./columns";
import { workspaceId } from "./tenancy";

/**
 * Paid app credits a call used (EN.15, ADR-0048): the catalog's estimate,
 * written once per call (keyed like the call) when it starts, since a
 * provider may charge for a job that later fails. Read against the
 * workspace's monthly cap, and per agent in Activity. The agent isn't a
 * foreign key: spending stays on the books after an agent is removed.
 */
export const spend = pgTable(
  "spend",
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid("agent_id").notNull(),
    runId: uuid("run_id").notNull(),
    /** `runId:step`, so a retried call is counted once. */
    idempotencyKey: text("idempotency_key").notNull(),
    tool: text("tool").notNull(),
    costCents: integer("cost_cents").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("spend_cost_ck", sql`${t.costCents} >= 0`),
    uniqueIndex("spend_workspace_key_uq").on(t.workspaceId, t.idempotencyKey),
    index("spend_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);
