import type { TenantContext } from "@ofa/core";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { episode, membership, memory, workspace } from "../schema/index";
import { withTenant } from "../tenant";

// Nightly memory consolidation (ARCHITECTURE.md §8, M5.09): the rows it reads
// and the changes it makes. Facts are never deleted here, only expired, so
// a merge can be traced and nothing a person confirmed silently vanishes.

const live = () => or(isNull(memory.expiresAt), gt(memory.expiresAt, sql`now()`))!;

export interface ConsolidationCandidate {
  readonly workspaceId: string;
  readonly userId: string;
  readonly timeZone: string;
  readonly consolidatedAt: Date | null;
}

/** Every workspace with its owner, time zone and last pass (owner connection). */
export async function listConsolidationCandidates(
  ownerDb: Database,
): Promise<ConsolidationCandidate[]> {
  const rows = await ownerDb
    .selectDistinctOn([workspace.id], {
      workspaceId: workspace.id,
      userId: membership.userId,
      timeZone: workspace.timeZone,
      consolidatedAt: workspace.memoryConsolidatedAt,
    })
    .from(workspace)
    .innerJoin(
      membership,
      and(eq(membership.workspaceId, workspace.id), eq(membership.role, "owner")),
    )
    .orderBy(workspace.id, asc(membership.createdAt));
  return rows;
}

/** Agents with facts of their own or episodes not yet read. */
export async function agentsWithMemory(db: Database, ctx: TenantContext): Promise<string[]> {
  return withTenant(db, ctx, async (tx) => {
    const facts = await tx
      .selectDistinct({ agentId: memory.agentId })
      .from(memory)
      .where(and(eq(memory.scope, "agent"), live()));
    const fresh = await tx
      .selectDistinct({ agentId: episode.agentId })
      .from(episode)
      .where(isNull(episode.consolidatedAt));
    return [...new Set([...facts, ...fresh].flatMap((r) => (r.agentId ? [r.agentId] : [])))].sort();
  });
}

export interface FactRow {
  readonly id: string;
  readonly kind: "fact" | "preference" | "episode";
  readonly content: string;
  readonly verified: boolean;
}

/** One agent's own facts, or (agent null) the shared workspace facts: newest first. */
export async function factsToConsolidate(
  db: Database,
  ctx: TenantContext,
  agentId: string | null,
  limit: number,
): Promise<FactRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
        verified: memory.verified,
      })
      .from(memory)
      .where(
        and(
          agentId
            ? and(eq(memory.scope, "agent"), eq(memory.agentId, agentId))
            : eq(memory.scope, "workspace"),
          live(),
        ),
      )
      .orderBy(desc(memory.createdAt))
      .limit(limit),
  );
}

/**
 * Replace facts with one that says the same: the new fact is verified only
 * if every one it replaces was, and the old ones expire now. Facts outside
 * the given owner are left alone.
 */
export async function mergeFacts(
  db: Database,
  ctx: TenantContext,
  input: { agentId: string | null; ids: string[]; content: string; now: Date },
): Promise<boolean> {
  return withTenant(db, ctx, async (tx) => {
    const owner = input.agentId
      ? and(eq(memory.scope, "agent"), eq(memory.agentId, input.agentId))
      : eq(memory.scope, "workspace");
    const sources = await tx
      .select({ id: memory.id, kind: memory.kind, verified: memory.verified })
      .from(memory)
      .where(and(inArray(memory.id, input.ids), owner, live()));
    if (sources.length < 2) return false;
    await tx.insert(memory).values({
      workspaceId: ctx.workspaceId,
      scope: input.agentId ? "agent" : "workspace",
      agentId: input.agentId,
      kind: sources.every((s) => s.kind === "preference") ? "preference" : "fact",
      content: input.content,
      verified: sources.every((s) => s.verified),
    });
    await tx
      .update(memory)
      .set({ expiresAt: input.now })
      .where(
        inArray(
          memory.id,
          sources.map((s) => s.id),
        ),
      );
    return true;
  });
}

/**
 * Expire what is stale: copies of the same fact for the same owner (the
 * oldest, preferably confirmed, stays); unconfirmed facts nobody confirmed
 * in `unverifiedDays`; facts never recalled in `unusedDays`. Preferences are
 * kept unless duplicated. Returns how many expired.
 */
export async function expireStaleFacts(
  db: Database,
  ctx: TenantContext,
  input: { now: Date; unverifiedDays: number; unusedDays: number },
): Promise<number> {
  const day = 24 * 60 * 60_000;
  return withTenant(db, ctx, async (tx) => {
    const copies = await tx.execute<{ id: string }>(sql`
      update ${memory} set expires_at = ${input.now.toISOString()}::timestamptz
      where id in (
        select id from (
          select id, row_number() over (
            partition by scope, agent_id, user_id,
              trim(regexp_replace(lower(content), '[^a-z0-9]+', ' ', 'g'))
            order by verified desc, created_at
          ) as n
          from ${memory}
          where expires_at is null or expires_at > now()
        ) ranked where n > 1
      )
      returning id`);
    const unconfirmed = await tx
      .update(memory)
      .set({ expiresAt: input.now })
      .where(
        and(
          eq(memory.verified, false),
          lt(memory.createdAt, new Date(input.now.getTime() - input.unverifiedDays * day)),
          live(),
        ),
      )
      .returning({ id: memory.id });
    const unused = await tx
      .update(memory)
      .set({ expiresAt: input.now })
      .where(
        and(
          eq(memory.kind, "fact"),
          isNull(memory.lastRecalledAt),
          lt(memory.createdAt, new Date(input.now.getTime() - input.unusedDays * day)),
          live(),
        ),
      )
      .returning({ id: memory.id });
    return copies.length + unconfirmed.length + unused.length;
  });
}

export async function markWorkspaceConsolidated(
  db: Database,
  ctx: TenantContext,
  now: Date,
): Promise<void> {
  await withTenant(db, ctx, (tx) =>
    tx
      .update(workspace)
      .set({ memoryConsolidatedAt: now })
      .where(eq(workspace.id, ctx.workspaceId)),
  );
}
