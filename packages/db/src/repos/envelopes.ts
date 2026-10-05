import type { TenantContext } from "@ofa/core";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../client";
import { connection, mcpServer, membership, secret } from "../schema/index";
import { withTenant } from "../tenant";

// Every envelope-encrypted value in a workspace, for `packages/vault`: key
// rotation re-wraps them all, and redaction needs to know every value. Rows
// hold ciphertext only; the vault owns the key (ADR-0012).

export type EnvelopeTable = "secret" | "connection" | "mcp_server";

export interface StoredEnvelope {
  readonly table: EnvelopeTable;
  readonly id: string;
  /** The secret's name: part of its ciphertext binding. Null for the other tables. */
  readonly name: string | null;
  readonly valueCiphertext: string;
  readonly keyCiphertext: string;
  readonly keyId: string;
}

export async function listEnvelopes(db: Database, ctx: TenantContext): Promise<StoredEnvelope[]> {
  return withTenant(db, ctx, async (tx) => {
    const secrets = await tx
      .select({
        id: secret.id,
        name: secret.name,
        valueCiphertext: secret.valueCiphertext,
        keyCiphertext: secret.keyCiphertext,
        keyId: secret.keyId,
      })
      .from(secret);
    const connections = await tx
      .select({
        id: connection.id,
        valueCiphertext: connection.credentialsCiphertext,
        keyCiphertext: connection.keyCiphertext,
        keyId: connection.keyId,
      })
      .from(connection)
      .where(isNotNull(connection.credentialsCiphertext));
    const servers = await tx
      .select({
        id: mcpServer.id,
        valueCiphertext: mcpServer.clientCiphertext,
        keyCiphertext: mcpServer.clientKeyCiphertext,
        keyId: mcpServer.clientKeyId,
      })
      .from(mcpServer)
      .where(isNotNull(mcpServer.clientCiphertext));
    // The checks on both tables keep the three columns all set or all null.
    const sealed = (table: EnvelopeTable) => (row: (typeof connections)[number]) => ({
      table,
      id: row.id,
      name: null,
      valueCiphertext: row.valueCiphertext ?? "",
      keyCiphertext: row.keyCiphertext ?? "",
      keyId: row.keyId ?? "",
    });
    return [
      ...secrets.map((row) => ({ table: "secret" as const, ...row })),
      ...connections.map(sealed("connection")),
      ...servers.map(sealed("mcp_server")),
    ];
  });
}

/**
 * Replace an envelope's wrapped data key, only if it is still wrapped by
 * `fromKeyId`: a value saved again meanwhile is left alone. Not an edit, so
 * `updated_at` is kept. Returns false when nothing matched.
 */
export async function rewrapStoredEnvelope(
  db: Database,
  ctx: TenantContext,
  ref: { readonly table: EnvelopeTable; readonly id: string },
  fromKeyId: string,
  to: { readonly keyCiphertext: string; readonly keyId: string },
): Promise<boolean> {
  return withTenant(db, ctx, async (tx) => {
    switch (ref.table) {
      case "secret":
        return (
          (
            await tx
              .update(secret)
              .set({ ...to, updatedAt: sql`${secret.updatedAt}` })
              .where(and(eq(secret.id, ref.id), eq(secret.keyId, fromKeyId)))
              .returning({ id: secret.id })
          ).length > 0
        );
      case "connection":
        return (
          (
            await tx
              .update(connection)
              .set({ ...to, updatedAt: sql`${connection.updatedAt}` })
              .where(and(eq(connection.id, ref.id), eq(connection.keyId, fromKeyId)))
              .returning({ id: connection.id })
          ).length > 0
        );
      case "mcp_server":
        return (
          (
            await tx
              .update(mcpServer)
              .set({
                clientKeyCiphertext: to.keyCiphertext,
                clientKeyId: to.keyId,
                updatedAt: sql`${mcpServer.updatedAt}`,
              })
              .where(and(eq(mcpServer.id, ref.id), eq(mcpServer.clientKeyId, fromKeyId)))
              .returning({ id: mcpServer.id })
          ).length > 0
        );
    }
  });
}

/**
 * Maintenance only (vault key rotation): each workspace with one of its
 * owners, to act as in `withTenant`. Needs the owner connection
 * (`DATABASE_MIGRATION_URL`), which bypasses row-level security like
 * migrations do; request code never calls this.
 */
export async function listWorkspaceOwners(
  ownerDb: Database,
): Promise<{ workspaceId: string; userId: string }[]> {
  return ownerDb
    .selectDistinctOn([membership.workspaceId], {
      workspaceId: membership.workspaceId,
      userId: membership.userId,
    })
    .from(membership)
    .where(eq(membership.role, "owner"))
    .orderBy(membership.workspaceId, membership.createdAt);
}
