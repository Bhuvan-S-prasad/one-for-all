import type { TenantContext } from "@ofa/core";
import type { Database } from "../client";
import { auditLog } from "../schema/index";
import { withTenant } from "../tenant";

export interface AuditEntry {
  /** `noun.verb`, e.g. `session.created`. */
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly data?: Record<string, unknown>;
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** Append an audit entry for an action the current user took. Entries are never changed. */
export async function recordAudit(
  db: Database,
  ctx: TenantContext,
  entry: AuditEntry,
): Promise<void> {
  await withTenant(db, ctx, (tx) =>
    tx.insert(auditLog).values({
      workspaceId: ctx.workspaceId,
      actorType: ctx.agentId ? "agent" : "user",
      actorId: ctx.agentId ?? ctx.userId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      data: entry.data ?? {},
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
    }),
  );
}
