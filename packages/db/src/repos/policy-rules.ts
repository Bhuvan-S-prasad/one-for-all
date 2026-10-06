import type {
  PolicyRule,
  PolicyRuleEffect,
  PolicyRuleStore,
  RunContext,
  TenantContext,
} from "@ofa/core";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Database } from "../client";
import { policyRule } from "../schema/index";
import { withTenant } from "../tenant";

// Ask-first and allow-auto rules (ARCHITECTURE.md §10.2). A rule without a
// person is the workspace's; with one, that person's own, which the database
// lets only ask first. The policy engine reads the rules for each tool call.

export interface PolicyRuleRecord extends PolicyRule {
  /** The person a personal rule belongs to; null for a workspace rule. */
  readonly userId: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface PolicyRuleInput {
  readonly tool: string;
  readonly effect: PolicyRuleEffect;
  readonly scope: "workspace" | "personal";
  readonly agentId: string | null;
  readonly description: string;
}

const columns = {
  id: policyRule.id,
  tool: policyRule.tool,
  effect: policyRule.effect,
  userId: policyRule.userId,
  agentId: policyRule.agentId,
  description: policyRule.description,
  enabled: policyRule.enabled,
  createdAt: policyRule.createdAt,
};

type Row = {
  id: string;
  tool: string;
  effect: string;
  userId: string | null;
  agentId: string | null;
  description: string;
  enabled: boolean;
  createdAt: Date;
};

function toRecord(row: Row): PolicyRuleRecord {
  return {
    ...row,
    effect: row.effect as PolicyRuleEffect,
    scope: row.userId ? "personal" : "workspace",
  };
}

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

/** The workspace's rules and the signed-in person's own, oldest first. */
export async function listPolicyRules(
  db: Database,
  ctx: TenantContext,
): Promise<PolicyRuleRecord[]> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select(columns)
      .from(policyRule)
      .where(or(isNull(policyRule.userId), eq(policyRule.userId, ctx.userId)))
      .orderBy(asc(policyRule.createdAt)),
  );
  return rows.map(toRecord);
}

export async function findPolicyRule(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<PolicyRuleRecord | null> {
  if (!isUuid(id)) return null;
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .select(columns)
      .from(policyRule)
      .where(
        and(
          eq(policyRule.id, id),
          or(isNull(policyRule.userId), eq(policyRule.userId, ctx.userId)),
        ),
      )
      .limit(1),
  );
  return row ? toRecord(row) : null;
}

/** Returns null when the same rule already exists. */
export async function createPolicyRule(
  db: Database,
  ctx: TenantContext,
  input: PolicyRuleInput,
): Promise<PolicyRuleRecord | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .insert(policyRule)
      .values({
        workspaceId: ctx.workspaceId,
        userId: input.scope === "personal" ? ctx.userId : null,
        agentId: input.agentId,
        tool: input.tool,
        effect: input.effect,
        description: input.description,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning(columns),
  );
  return row ? toRecord(row) : null;
}

export async function setPolicyRuleEnabled(
  db: Database,
  ctx: TenantContext,
  id: string,
  enabled: boolean,
): Promise<PolicyRuleRecord | null> {
  if (!isUuid(id)) return null;
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.update(policyRule).set({ enabled }).where(eq(policyRule.id, id)).returning(columns),
  );
  return row ? toRecord(row) : null;
}

export async function deletePolicyRule(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await withTenant(db, ctx, (tx) =>
    tx.delete(policyRule).where(eq(policyRule.id, id)).returning({ id: policyRule.id }),
  );
  return rows.length > 0;
}

/** The policy engine's view: enabled rules for this run's person and agent. */
export function createPolicyRuleStore(db: Database): PolicyRuleStore {
  return {
    async listForRun(ctx: RunContext) {
      const rows = await withTenant(db, ctx, (tx) =>
        tx
          .select(columns)
          .from(policyRule)
          .where(
            and(
              eq(policyRule.enabled, true),
              or(isNull(policyRule.userId), eq(policyRule.userId, ctx.userId)),
              or(isNull(policyRule.agentId), eq(policyRule.agentId, ctx.agentId)),
            ),
          ),
      );
      return rows.map(toRecord);
    },
  };
}
