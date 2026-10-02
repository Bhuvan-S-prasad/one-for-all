import type { AgentGrant, AgentSpec } from "@ofa/contracts";
import { AppError, type TenantContext } from "@ofa/core";
import { asc, eq, inArray, ne } from "drizzle-orm";
import type { Database } from "../client";
import { agent, agentGrant } from "../schema/index";
import { withTenant, type Tx } from "../tenant";

// Agents and their grants, for the API (M2.19). The runtime reads agents
// through `createAgentDirectory` in runtime.ts.

export type AgentRow = typeof agent.$inferSelect;

export interface AgentWithGrants extends AgentRow {
  readonly grants: AgentGrant[];
}

export interface AgentWrite {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly spec: AgentSpec;
  readonly grants: readonly AgentGrant[];
}

async function grantsFor(tx: Tx, agentIds: string[]): Promise<Map<string, AgentGrant[]>> {
  const map = new Map<string, AgentGrant[]>();
  if (agentIds.length === 0) return map;
  const rows = await tx
    .select({ agentId: agentGrant.agentId, tool: agentGrant.tool, mode: agentGrant.mode })
    .from(agentGrant)
    .where(inArray(agentGrant.agentId, agentIds))
    .orderBy(asc(agentGrant.tool));
  for (const row of rows) {
    const list = map.get(row.agentId) ?? [];
    list.push({ tool: row.tool, mode: row.mode });
    map.set(row.agentId, list);
  }
  return map;
}

async function replaceGrants(
  tx: Tx,
  ctx: TenantContext,
  agentId: string,
  grants: readonly AgentGrant[],
) {
  await tx.delete(agentGrant).where(eq(agentGrant.agentId, agentId));
  if (grants.length > 0) {
    await tx
      .insert(agentGrant)
      .values(
        grants.map((g) => ({ ...g, workspaceId: ctx.workspaceId, agentId, createdBy: ctx.userId })),
      );
  }
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause ?? (error as { code?: string });
  return (cause as { code?: string }).code === "23505";
}

/** Agents that are not archived, oldest first. */
export async function listAgents(db: Database, ctx: TenantContext): Promise<AgentWithGrants[]> {
  return withTenant(db, ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(agent)
      .where(ne(agent.status, "archived"))
      .orderBy(asc(agent.createdAt));
    const grants = await grantsFor(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((row) => ({ ...row, grants: grants.get(row.id) ?? [] }));
  });
}

export async function getAgent(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<AgentWithGrants | null> {
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx.select().from(agent).where(eq(agent.id, id)).limit(1);
    if (!row) return null;
    const grants = await grantsFor(tx, [row.id]);
    return { ...row, grants: grants.get(row.id) ?? [] };
  });
}

export async function createAgent(
  db: Database,
  ctx: TenantContext,
  input: AgentWrite,
): Promise<AgentWithGrants> {
  try {
    return await withTenant(db, ctx, async (tx) => {
      const [row] = await tx
        .insert(agent)
        .values({
          workspaceId: ctx.workspaceId,
          slug: input.slug,
          name: input.name,
          description: input.description,
          spec: input.spec,
          createdBy: ctx.userId,
        })
        .returning();
      if (!row) throw new Error("agent insert returned no row");
      await replaceGrants(tx, ctx, row.id, input.grants);
      return { ...row, grants: [...input.grants] };
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new AppError("conflict", `An agent called @${input.slug} already exists`);
    throw error;
  }
}

export async function updateAgent(
  db: Database,
  ctx: TenantContext,
  id: string,
  patch: Partial<AgentWrite> & { readonly status?: AgentRow["status"] },
): Promise<AgentWithGrants | null> {
  try {
    return await withTenant(db, ctx, async (tx) => {
      const { grants, ...fields } = patch;
      const [row] =
        Object.keys(fields).length > 0
          ? await tx.update(agent).set(fields).where(eq(agent.id, id)).returning()
          : await tx.select().from(agent).where(eq(agent.id, id)).limit(1);
      if (!row) return null;
      if (grants) await replaceGrants(tx, ctx, id, grants);
      const current = await grantsFor(tx, [id]);
      return { ...row, grants: current.get(id) ?? [] };
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new AppError("conflict", `An agent called @${patch.slug} already exists`);
    throw error;
  }
}
