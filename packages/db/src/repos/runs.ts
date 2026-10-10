import type { TenantContext } from "@ofa/core";
import { and, asc, desc, eq, exists, gt, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { message, run, runEvent } from "../schema/index";
import { withTenant } from "../tenant";

// Runs and their event logs, read by the API for Activity (M2.19).

export type RunEventRow = typeof runEvent.$inferSelect;

export async function getRun(db: Database, ctx: TenantContext, id: string) {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select().from(run).where(eq(run.id, id)).limit(1),
  );
  return row ?? null;
}

type RunStatusValue = (typeof run.$inferSelect)["status"];
type RunTriggerValue = (typeof run.$inferSelect)["trigger"];

/** Runs that haven't ended, in a thread or of an agent, oldest first (M5.05). */
export async function listActiveRuns(
  db: Database,
  ctx: TenantContext,
  options: { threadId?: string; agentId?: string; triggers?: readonly RunTriggerValue[] },
) {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(run)
      .where(
        and(
          inArray(run.status, ["queued", "running", "waiting"]),
          options.threadId ? eq(run.threadId, options.threadId) : undefined,
          options.agentId ? eq(run.agentId, options.agentId) : undefined,
          options.triggers?.length ? inArray(run.trigger, [...options.triggers]) : undefined,
        ),
      )
      .orderBy(asc(run.createdAt))
      .limit(50),
  );
}

/** `%`, `_` and `\` match literally in a search. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Newest runs first. Filters: one agent, some statuses, and `search` over what
 * was asked (the message that started the run).
 */
export async function listRuns(
  db: Database,
  ctx: TenantContext,
  options: {
    limit: number;
    agentId?: string;
    before?: string;
    statuses?: readonly RunStatusValue[];
    search?: string;
  },
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
          options.statuses?.length ? inArray(run.status, [...options.statuses]) : undefined,
          options.search
            ? exists(
                tx
                  .select({ one: sql`1` })
                  .from(message)
                  .where(
                    and(
                      eq(message.runId, run.id),
                      eq(message.authorType, "user"),
                      ilike(message.content, likePattern(options.search)),
                    ),
                  ),
              )
            : undefined,
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

/**
 * The start of what was asked and of the reply, per run (UX.10): the user
 * message that started each run and the agent message it posted.
 */
export async function runPreviews(
  db: Database,
  ctx: TenantContext,
  runIds: readonly string[],
  chars: number,
): Promise<Map<string, { request: string | null; reply: string | null }>> {
  const previews = new Map<string, { request: string | null; reply: string | null }>();
  if (runIds.length === 0) return previews;
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select({
        runId: message.runId,
        authorType: message.authorType,
        // A handoff's brief is written by the agent handing the work over (M5.01).
        byRunAgent: sql<boolean>`${message.authorAgentId} = ${run.agentId}`,
        text: sql<string>`left(${message.content}, ${chars})`,
      })
      .from(message)
      .innerJoin(run, eq(run.id, message.runId))
      .where(
        and(inArray(message.runId, [...runIds]), inArray(message.authorType, ["user", "agent"])),
      )
      .orderBy(asc(message.createdAt)),
  );
  for (const row of rows) {
    if (!row.runId) continue;
    const entry = previews.get(row.runId) ?? { request: null, reply: null };
    if (row.authorType === "user" || !row.byRunAgent) entry.request ??= row.text;
    else entry.reply ??= row.text;
    previews.set(row.runId, entry);
  }
  return previews;
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

/** Model calls logged since a time, per model (UX.11: the day's free quota). */
export async function modelCallsSince(
  db: Database,
  ctx: TenantContext,
  since: Date,
): Promise<{ model: string; calls: number }[]> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select({
        model: sql<string>`${runEvent.payload}->>'model'`,
        calls: sql<number>`count(*)::int`,
      })
      .from(runEvent)
      .where(and(eq(runEvent.type, "model.called"), gte(runEvent.createdAt, since)))
      .groupBy(sql`${runEvent.payload}->>'model'`),
  );
  return rows.map((r) => ({ model: r.model ?? "", calls: Number(r.calls) }));
}

/**
 * Per agent (UX.12): runs started since a time, and the latest run that
 * finished well.
 */
export async function agentRunStats(
  db: Database,
  ctx: TenantContext,
  since: Date,
): Promise<{ agentId: string; runsSince: number; lastSucceeded: RunRow | null }[]> {
  return withTenant(db, ctx, async (tx) => {
    const counts = await tx
      .select({ agentId: run.agentId, runs: sql<number>`count(*)::int` })
      .from(run)
      .where(gte(run.createdAt, since))
      .groupBy(run.agentId);
    const latest = await tx
      .selectDistinctOn([run.agentId])
      .from(run)
      .where(eq(run.status, "succeeded"))
      .orderBy(run.agentId, desc(run.createdAt));
    const stats = new Map<string, { runsSince: number; lastSucceeded: RunRow | null }>();
    for (const c of counts)
      stats.set(c.agentId, { runsSince: Number(c.runs), lastSucceeded: null });
    for (const row of latest) {
      const entry = stats.get(row.agentId) ?? { runsSince: 0, lastSucceeded: null };
      stats.set(row.agentId, { ...entry, lastSucceeded: row });
    }
    return [...stats].map(([agentId, s]) => ({ agentId, ...s }));
  });
}

type RunRow = typeof run.$inferSelect;
