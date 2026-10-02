import {
  asId,
  type MemoryId,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type TenantContext,
} from "@ofa/core";
import { and, desc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../client";
import { memory } from "../schema/index";
import { withTenant } from "../tenant";

// Storage for `packages/memory`. Who may see a row follows its scope
// (ARCHITECTURE.md §8): workspace facts are shared, agent facts belong to one
// agent, agent_user facts to one agent and one person.

export interface MemoryInsert {
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly verified: boolean;
}

function toRecord(row: {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  verified: boolean;
  createdAt: Date;
}): MemoryRecord {
  return { ...row, id: asId<MemoryId>(row.id) };
}

const columns = {
  id: memory.id,
  scope: memory.scope,
  kind: memory.kind,
  content: memory.content,
  verified: memory.verified,
  createdAt: memory.createdAt,
};

/** Rows of the requested scopes that this agent and person may see. */
function visible(ctx: TenantContext, scopes: readonly MemoryScope[]): SQL | undefined {
  const parts: SQL[] = [];
  if (scopes.includes("workspace")) parts.push(eq(memory.scope, "workspace"));
  if (ctx.agentId && scopes.includes("agent")) {
    parts.push(and(eq(memory.scope, "agent"), eq(memory.agentId, ctx.agentId))!);
  }
  if (ctx.agentId && scopes.includes("agent_user")) {
    parts.push(
      and(
        eq(memory.scope, "agent_user"),
        eq(memory.agentId, ctx.agentId),
        eq(memory.userId, ctx.userId),
      )!,
    );
  }
  return parts.length ? or(...parts) : sql`false`;
}

/** Store a fact. The same text in the same place is stored once. */
export async function insertMemory(
  db: Database,
  ctx: TenantContext,
  input: MemoryInsert,
): Promise<MemoryRecord> {
  if (input.scope !== "workspace" && !ctx.agentId) {
    throw new Error(`${input.scope} memory needs an agent`);
  }
  return withTenant(db, ctx, async (tx) => {
    const owner = {
      agentId: input.scope === "workspace" ? null : (ctx.agentId ?? null),
      userId: input.scope === "agent_user" ? ctx.userId : null,
    };
    const [existing] = await tx
      .select(columns)
      .from(memory)
      .where(
        and(visible(ctx, [input.scope]), sql`lower(${memory.content}) = lower(${input.content})`),
      )
      .limit(1);
    if (existing) return toRecord(existing);
    const [row] = await tx
      .insert(memory)
      .values({ workspaceId: ctx.workspaceId, ...owner, ...input, sourceRunId: ctx.runId ?? null })
      .returning(columns);
    if (!row) throw new Error("memory insert returned no row");
    return toRecord(row);
  });
}

export interface MemorySearch {
  readonly query: string;
  readonly scopes: readonly MemoryScope[];
  readonly limit: number;
  readonly includeUnverified?: boolean;
}

/**
 * Full-text recall: any word may match (natural questions rarely share every
 * word with a stored fact), ranked by match quality, then by recency. With no
 * usable words, the most recent facts.
 */
export async function searchMemories(
  db: Database,
  ctx: TenantContext,
  search: MemorySearch,
): Promise<MemoryRecord[]> {
  const words = [...new Set(search.query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(
    0,
    32,
  );
  const filters = and(
    visible(ctx, search.scopes),
    search.includeUnverified ? undefined : eq(memory.verified, true),
    or(isNull(memory.expiresAt), gt(memory.expiresAt, sql`now()`)),
  );
  return withTenant(db, ctx, async (tx) => {
    if (words.length === 0) {
      const rows = await tx
        .select(columns)
        .from(memory)
        .where(filters)
        .orderBy(desc(memory.createdAt))
        .limit(search.limit);
      return rows.map(toRecord);
    }
    // to_tsquery handles stemming and drops stop words; words are letters and
    // digits only, so nothing in them is tsquery syntax.
    const query = sql`to_tsquery('english', ${words.join(" | ")})`;
    const rows = await tx
      .select(columns)
      .from(memory)
      .where(and(filters, sql`${memory.contentSearch} @@ ${query}`))
      .orderBy(desc(sql`ts_rank_cd(${memory.contentSearch}, ${query})`), desc(memory.createdAt))
      .limit(search.limit);
    return rows.map(toRecord);
  });
}
