import { spendMonthStart, type SpendLedger, type TenantContext } from "@ofa/core";
import { desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../client";
import { agent, spend, workspace } from "../schema/index";
import { withTenant } from "../tenant";

// Paid app credits (EN.15, ADR-0048): the ledger the executor writes, the
// monthly cap it checks, and the month's spending per agent for Activity.

export function createSpendLedger(db: Database, now: () => Date = () => new Date()): SpendLedger {
  return {
    async month(ctx) {
      return withTenant(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            capCents: workspace.spendCapCents,
            spentCents: sql<number>`coalesce((select sum(${spend.costCents}) from ${spend} where ${spend.createdAt} >= ${spendMonthStart(now()).toISOString()}), 0)::int`,
          })
          .from(workspace)
          .where(eq(workspace.id, ctx.workspaceId));
        return { spentCents: row?.spentCents ?? 0, capCents: row?.capCents ?? null };
      });
    },

    async record(ctx, entry) {
      await withTenant(db, ctx, (tx) =>
        tx
          .insert(spend)
          .values({
            workspaceId: ctx.workspaceId,
            agentId: ctx.agentId,
            runId: ctx.runId,
            idempotencyKey: entry.idempotencyKey,
            tool: entry.tool,
            costCents: entry.costCents,
          })
          .onConflictDoNothing({ target: [spend.workspaceId, spend.idempotencyKey] }),
      );
    },
  };
}

export interface SpendByAgent {
  readonly agentId: string;
  /** Null when the agent has since been removed. */
  readonly name: string | null;
  readonly calls: number;
  readonly spentCents: number;
}

/** Spending since a date, per agent, most first. */
export async function spendByAgentSince(
  db: Database,
  ctx: TenantContext,
  since: Date,
): Promise<SpendByAgent[]> {
  return withTenant(db, ctx, async (tx) => {
    const spent = sql<number>`sum(${spend.costCents})::int`;
    const rows = await tx
      .select({
        agentId: spend.agentId,
        name: agent.name,
        calls: sql<number>`count(*)::int`,
        spentCents: spent,
      })
      .from(spend)
      .leftJoin(agent, eq(agent.id, spend.agentId))
      .where(gte(spend.createdAt, since))
      .groupBy(spend.agentId, agent.name)
      .orderBy(desc(spent));
    return rows.map((r) => ({ ...r, name: r.name ?? null }));
  });
}

export async function setSpendCap(
  db: Database,
  ctx: TenantContext,
  capCents: number | null,
): Promise<void> {
  await withTenant(db, ctx, (tx) =>
    tx.update(workspace).set({ spendCapCents: capCents }).where(eq(workspace.id, ctx.workspaceId)),
  );
}
