import type { EpisodeOutcome, EpisodeRecord, RunContext, TenantContext } from "@ofa/core";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import { episode } from "../schema/index";
import { withTenant } from "../tenant";

// Episodic memory (ARCHITECTURE.md §8, M5.09): one episode per run that
// replied. Recall finds earlier work like the current request; nightly
// consolidation reads the new ones.

export type EpisodeRow = typeof episode.$inferSelect;

/** The run's episode; a second write (the learning pass) replaces the summary. */
export async function upsertEpisode(
  db: Database,
  ctx: RunContext,
  input: { threadId: string | null; summary: string; outcome: EpisodeOutcome; tainted: boolean },
): Promise<void> {
  await withTenant(db, ctx, (tx) =>
    tx
      .insert(episode)
      .values({
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        userId: ctx.userId,
        runId: ctx.runId,
        threadId: input.threadId,
        summary: input.summary,
        outcome: input.outcome,
        tainted: input.tainted,
      })
      .onConflictDoUpdate({
        target: episode.runId,
        set: {
          summary: input.summary,
          outcome: input.outcome,
          // Once tainted, always: a later write can't clear it.
          tainted: sql`${episode.tainted} or ${input.tainted}`,
          updatedAt: new Date(),
        },
      }),
  );
}

/**
 * The agent's past episodes for this person that match the query, best
 * first. Never tainted ones: their summaries may carry someone else's words.
 */
export async function searchEpisodes(
  db: Database,
  ctx: RunContext,
  search: { query: string; limit: number },
): Promise<EpisodeRecord[]> {
  const words = [...new Set(search.query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(
    0,
    32,
  );
  if (words.length === 0) return [];
  const query = sql`to_tsquery('english', ${words.join(" | ")})`;
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select({
        runId: episode.runId,
        summary: episode.summary,
        outcome: episode.outcome,
        createdAt: episode.createdAt,
      })
      .from(episode)
      .where(
        and(
          eq(episode.agentId, ctx.agentId),
          eq(episode.userId, ctx.userId),
          eq(episode.tainted, false),
          sql`${episode.runId} <> ${ctx.runId}`,
          sql`${episode.summarySearch} @@ ${query}`,
        ),
      )
      .orderBy(desc(sql`ts_rank_cd(${episode.summarySearch}, ${query})`), desc(episode.createdAt))
      .limit(search.limit),
  );
  return rows;
}

export async function listEpisodes(
  db: Database,
  ctx: TenantContext,
  options: { agentId?: string; limit: number },
): Promise<EpisodeRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(episode)
      .where(options.agentId ? eq(episode.agentId, options.agentId) : undefined)
      .orderBy(desc(episode.createdAt))
      .limit(options.limit),
  );
}

/** An agent's episodes not yet read by consolidation, oldest first; untainted only. */
export async function newEpisodes(
  db: Database,
  ctx: TenantContext,
  agentId: string,
  limit: number,
): Promise<EpisodeRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(episode)
      .where(
        and(
          eq(episode.agentId, agentId),
          isNull(episode.consolidatedAt),
          eq(episode.tainted, false),
        ),
      )
      .orderBy(episode.createdAt)
      .limit(limit),
  );
}

/** Mark an agent's episodes up to `now` as read, tainted ones included, and drop very old ones. */
export async function closeEpisodes(
  db: Database,
  ctx: TenantContext,
  agentId: string,
  now: Date,
  dropBefore: Date,
): Promise<void> {
  await withTenant(db, ctx, async (tx) => {
    await tx
      .update(episode)
      .set({ consolidatedAt: now })
      .where(
        and(
          eq(episode.agentId, agentId),
          isNull(episode.consolidatedAt),
          lt(episode.createdAt, now),
        ),
      );
    await tx
      .delete(episode)
      .where(and(eq(episode.agentId, agentId), lt(episode.createdAt, dropBefore)));
  });
}
