import type { TenantContext } from "@ofa/core";
import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";
import type { Database } from "../client";
import { run, runEvent } from "../schema/index";
import { withTenant } from "../tenant";

// Runs and their event logs, read by the API for Activity (M2.19).

export type RunEventRow = typeof runEvent.$inferSelect;

export async function getRun(db: Database, ctx: TenantContext, id: string) {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select().from(run).where(eq(run.id, id)).limit(1),
  );
  return row ?? null;
}

/** Newest runs first, optionally for one agent. */
export async function listRuns(
  db: Database,
  ctx: TenantContext,
  options: { limit: number; agentId?: string; before?: string },
) {
  return withTenant(db, ctx, async (tx) => {
    let pivot: { createdAt: Date; id: string } | undefined;
    if (options.before) {
      [pivot] = await tx
        .select({ createdAt: run.createdAt, id: run.id })
        .from(run)
        .where(eq(run.id, options.before))
        .limit(1);
    }
    const rows = await tx
      .select()
      .from(run)
      .where(
        and(
          options.agentId ? eq(run.agentId, options.agentId) : undefined,
          pivot
            ? or(
                lt(run.createdAt, pivot.createdAt),
                and(eq(run.createdAt, pivot.createdAt), lt(run.id, pivot.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(run.createdAt), desc(run.id))
      .limit(options.limit + 1);
    const more = rows.length > options.limit;
    const items = rows.slice(0, options.limit);
    return { items, nextCursor: more ? (items.at(-1)?.id ?? null) : null };
  });
}

/** A run's events in order, optionally only those after `afterSeq`. */
export async function listRunEvents(
  db: Database,
  ctx: TenantContext,
  runId: string,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<RunEventRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(runEvent)
      .where(
        and(
          eq(runEvent.runId, runId),
          options.afterSeq !== undefined ? gt(runEvent.seq, options.afterSeq) : undefined,
        ),
      )
      .orderBy(asc(runEvent.seq))
      .limit(options.limit ?? 500),
  );
}

/** One event by its position, for the realtime gateway. */
export async function getRunEvent(db: Database, ctx: TenantContext, runId: string, seq: number) {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(runEvent)
      .where(and(eq(runEvent.runId, runId), eq(runEvent.seq, seq)))
      .limit(1),
  );
  return row ?? null;
}
