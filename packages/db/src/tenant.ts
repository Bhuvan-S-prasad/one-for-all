import { assertTenant, type TenantContext, type UserId, type WorkspaceId } from "@ofa/core";
import { sql } from "drizzle-orm";
import type { Database } from "./client";

/** A transaction handle; repository functions accept it wherever they accept a Database. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

/**
 * Tables with `workspace_id` and row-level security. The integration test
 * checks this list against the database, so a new tenant table that misses
 * its policy fails CI. Add new tenant tables here and in the RLS migration.
 */
export const TENANT_TABLES = [
  "workspace",
  "membership",
  "device",
  "agent",
  "agent_grant",
  "thread",
  "thread_member",
  "message",
  "run",
  "run_event",
  "tool_call",
  "memory",
  "secret",
  "audit_log",
  "artifact",
  "approval",
  "mcp_server",
  "connection",
  "policy_rule",
] as const;

/**
 * Set the row-level-security variables for the current transaction.
 * `set_config(..., true)` scopes them to the transaction, so a pooled
 * connection never carries one tenant's settings into another request.
 */
export async function setTenantSettings(
  tx: Tx,
  workspaceId: WorkspaceId | null,
  userId: UserId,
): Promise<void> {
  await tx.execute(
    sql`select set_config('app.workspace_id', ${workspaceId ?? ""}, true),
               set_config('app.user_id', ${userId}, true)`,
  );
}

/**
 * Run `fn` in a transaction scoped to one workspace (hard rule 3). Every
 * tenant query must go through here: without the settings, RLS hides all rows.
 */
export async function withTenant<T>(
  db: Database,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  assertTenant(ctx);
  return db.transaction(async (tx) => {
    await setTenantSettings(tx, ctx.workspaceId, ctx.userId);
    return fn(tx);
  });
}

/**
 * Run `fn` as a user with no workspace chosen yet. RLS then allows only the
 * user's own memberships and the workspaces they belong to; used to resolve a
 * session to a TenantContext.
 */
export async function withUser<T>(
  db: Database,
  userId: UserId,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantSettings(tx, null, userId);
    return fn(tx);
  });
}
