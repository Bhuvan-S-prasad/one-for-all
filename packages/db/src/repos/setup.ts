import { randomUUID } from "node:crypto";
import { AppError, asId, type UserId, type WorkspaceId } from "@ofa/core";
import { asc, sql } from "drizzle-orm";
import type { Database } from "../client";
import { account, auditLog, membership, user, workspace } from "../schema/index";
import { setTenantSettings } from "../tenant";

/** Arbitrary constant for `pg_advisory_xact_lock`; identifies the setup lock. */
const SETUP_LOCK_KEY = 7_001_001;

export interface BootstrapOwnerInput {
  readonly workspaceName: string;
  readonly name: string;
  readonly email: string;
  /** Hashed by the auth module; this package never sees the password. */
  readonly passwordHash: string;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface BootstrapOwnerResult {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

/** True once the owner account exists. Identity tables have no RLS, so no tenant is needed. */
export async function isSetupComplete(db: Database): Promise<boolean> {
  const rows = await db.select({ id: user.id }).from(user).limit(1);
  return rows.length > 0;
}

/** The first user created: the owner from first-run setup. */
export async function findInstallOwner(
  db: Database,
): Promise<{ id: UserId; email: string } | undefined> {
  const [row] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .orderBy(asc(user.createdAt))
    .limit(1);
  return row && { id: asId<UserId>(row.id), email: row.email };
}

/**
 * First-run setup: create the owner, their password login, the workspace and
 * the owner membership in one transaction. Only works while no user exists.
 */
export async function bootstrapOwner(
  db: Database,
  input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> {
  return db.transaction(async (tx) => {
    // Two setup requests at once: the second waits here, then sees the owner.
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
    const existing = await tx.select({ id: user.id }).from(user).limit(1);
    if (existing.length > 0) {
      throw new AppError("conflict", "Setup is already complete");
    }

    const userId = asId<UserId>(randomUUID());
    const workspaceId = asId<WorkspaceId>(randomUUID());

    await tx.insert(user).values({
      id: userId,
      name: input.name,
      email: input.email.toLowerCase(),
    });
    // Better Auth's email + password login reads this row.
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: input.passwordHash,
    });

    // From here on, RLS applies: act inside the new workspace.
    await setTenantSettings(tx, workspaceId, userId);
    await tx.insert(workspace).values({ id: workspaceId, name: input.workspaceName });
    await tx.insert(membership).values({ workspaceId, userId, role: "owner" });
    await tx.insert(auditLog).values({
      workspaceId,
      actorType: "user",
      actorId: userId,
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspaceId,
      data: { via: "first-run-setup" },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { userId, workspaceId };
  });
}
