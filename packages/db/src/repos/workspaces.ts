import { asId, NotFoundError, type TenantContext, type UserId, type WorkspaceId } from "@ofa/core";
import { asc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { membership, workspace } from "../schema/index";
import { withTenant, withUser } from "../tenant";

export type MembershipRole = (typeof membership.$inferSelect)["role"];

export interface WorkspaceMembership {
  readonly workspaceId: WorkspaceId;
  readonly workspaceName: string;
  readonly role: MembershipRole;
}

/**
 * Every workspace the user belongs to, oldest membership first. Runs before a
 * workspace is chosen, so it takes a user ID rather than a TenantContext; RLS
 * limits it to the user's own memberships.
 */
export async function listMembershipsForUser(
  db: Database,
  userId: UserId,
): Promise<WorkspaceMembership[]> {
  const rows = await withUser(db, userId, (tx) =>
    tx
      .select({
        workspaceId: membership.workspaceId,
        workspaceName: workspace.name,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
      .where(eq(membership.userId, userId))
      .orderBy(asc(membership.createdAt)),
  );
  return rows.map((row) => ({ ...row, workspaceId: asId<WorkspaceId>(row.workspaceId) }));
}

export interface WorkspaceRecord {
  readonly id: WorkspaceId;
  readonly name: string;
  /** Where routines and reminders read clock times (M5.06). */
  readonly timeZone: string;
  readonly createdAt: Date;
}

export async function getWorkspace(db: Database, ctx: TenantContext): Promise<WorkspaceRecord> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select({
        id: workspace.id,
        name: workspace.name,
        timeZone: workspace.timeZone,
        createdAt: workspace.createdAt,
      })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId)),
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Workspace");
  return { ...row, id: asId<WorkspaceId>(row.id) };
}

/** Set the workspace time zone (an IANA name, checked by the caller). */
export async function setWorkspaceTimeZone(
  db: Database,
  ctx: TenantContext,
  timeZone: string,
): Promise<void> {
  await withTenant(db, ctx, (tx) =>
    tx.update(workspace).set({ timeZone }).where(eq(workspace.id, ctx.workspaceId)),
  );
}
