import {
  asId,
  type ApprovalRecord,
  type ApprovalScope,
  type ApprovalStatus,
  type ApprovalStore,
  type TenantContext,
  type Verdict,
} from "@ofa/core";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { approval, run } from "../schema/index";
import { withTenant, type Tx } from "../tenant";

// Approvals in Postgres. The row is the truth about a decision: the API
// settles it (only while pending) and then wakes the run, which reads it.

const columns = {
  id: approval.id,
  runId: approval.runId,
  agentId: approval.agentId,
  threadId: run.threadId,
  toolCallId: approval.toolCallId,
  tool: approval.tool,
  args: approval.args,
  summary: approval.summary,
  reasons: approval.reasons,
  verdict: approval.verdict,
  site: approval.site,
  scope: approval.scope,
  status: approval.status,
  decidedBy: approval.decidedBy,
  createdAt: approval.createdAt,
  decidedAt: approval.decidedAt,
  expiresAt: approval.expiresAt,
};

interface Row {
  id: string;
  runId: string;
  agentId: string;
  threadId: string | null;
  toolCallId: string;
  tool: string;
  args: unknown;
  summary: string;
  reasons: string[];
  verdict: Verdict;
  site: string | null;
  scope: string;
  status: string;
  decidedBy: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  expiresAt: Date;
}

function toRecord(row: Row): ApprovalRecord {
  return {
    ...row,
    runId: asId(row.runId),
    agentId: asId(row.agentId),
    scope: row.scope as ApprovalScope,
    status: row.status as ApprovalStatus,
  };
}

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export function createApprovalStore(db: Database): ApprovalStore {
  const select = (tx: Tx) =>
    tx.select(columns).from(approval).innerJoin(run, eq(run.id, approval.runId));

  return {
    async request(ctx, input) {
      return withTenant(db, ctx, async (tx) => {
        await tx
          .insert(approval)
          .values({
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            agentId: ctx.agentId,
            toolCallId: input.toolCallId,
            tool: input.tool,
            args: input.args ?? {},
            summary: input.summary.slice(0, 2_000),
            reasons: [...input.reasons],
            verdict: input.verdict,
            site: input.site ?? null,
            expiresAt: input.expiresAt,
          })
          .onConflictDoNothing({ target: [approval.runId, approval.toolCallId] });
        // New, or the one a retried step asked for the first time.
        const [row] = await select(tx)
          .where(and(eq(approval.runId, ctx.runId), eq(approval.toolCallId, input.toolCallId)))
          .limit(1);
        if (!row) throw new Error("approval vanished");
        return toRecord(row);
      });
    },

    async get(ctx: TenantContext, id: string) {
      if (!isUuid(id)) return null;
      const [row] = await withTenant(db, ctx, (tx) =>
        select(tx).where(eq(approval.id, id)).limit(1),
      );
      return row ? toRecord(row) : null;
    },

    async decide(ctx, id, input) {
      if (!isUuid(id)) return null;
      return withTenant(db, ctx, async (tx) => {
        const [updated] = await tx
          .update(approval)
          .set({
            status: input.status,
            decidedBy: input.decidedBy,
            decidedAt: new Date(),
            // A site-wide answer only means something for an approval that names a site.
            scope:
              input.status === "approved" && input.scope === "site"
                ? sql`case when ${approval.site} is null then 'once' else 'site' end`
                : "once",
          })
          .where(and(eq(approval.id, id), eq(approval.status, "pending")))
          .returning({ id: approval.id });
        if (!updated) return null;
        const [row] = await select(tx).where(eq(approval.id, id)).limit(1);
        return row ? toRecord(row) : null;
      });
    },

    async listPending(ctx, filter = {}) {
      if (filter.agentId && !isUuid(filter.agentId)) return [];
      if (filter.runId && !isUuid(filter.runId)) return [];
      const rows = await withTenant(db, ctx, (tx) =>
        select(tx)
          .where(
            and(
              eq(approval.status, "pending"),
              filter.agentId ? eq(approval.agentId, filter.agentId) : undefined,
              filter.runId ? eq(approval.runId, filter.runId) : undefined,
            ),
          )
          .orderBy(desc(approval.createdAt))
          .limit(100),
      );
      return rows.map(toRecord);
    },

    async expireForRun(ctx, runId) {
      if (!isUuid(runId)) return 0;
      const rows = await withTenant(db, ctx, (tx) =>
        tx
          .update(approval)
          .set({ status: "expired", decidedAt: new Date() })
          .where(and(eq(approval.runId, runId), eq(approval.status, "pending")))
          .returning({ id: approval.id }),
      );
      return rows.length;
    },
  };
}
