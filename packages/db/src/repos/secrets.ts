import { asId, type SecretId, type TenantContext } from "@ofa/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { secret } from "../schema/index";
import { withTenant } from "../tenant";

// Storage for `packages/vault`. Rows hold ciphertext only; encryption and
// decryption happen in the vault, which owns the key.

export interface SecretRecord {
  readonly id: SecretId;
  readonly name: string;
  readonly valueCiphertext: string;
  readonly keyCiphertext: string;
  readonly keyId: string;
  readonly hint: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface SecretWrite {
  readonly name: string;
  readonly valueCiphertext: string;
  readonly keyCiphertext: string;
  readonly keyId: string;
  readonly hint: string | null;
}

const columns = {
  id: secret.id,
  name: secret.name,
  valueCiphertext: secret.valueCiphertext,
  keyCiphertext: secret.keyCiphertext,
  keyId: secret.keyId,
  hint: secret.hint,
  createdAt: secret.createdAt,
  updatedAt: secret.updatedAt,
  lastUsedAt: secret.lastUsedAt,
};

function toRecord(row: Omit<SecretRecord, "id"> & { id: string }): SecretRecord {
  return { ...row, id: asId<SecretId>(row.id) };
}

/** Create the secret, or replace its value if the name exists. */
export async function upsertSecret(
  db: Database,
  ctx: TenantContext,
  input: SecretWrite,
): Promise<SecretRecord> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .insert(secret)
      .values({ ...input, workspaceId: ctx.workspaceId, createdBy: ctx.userId })
      .onConflictDoUpdate({
        target: [secret.workspaceId, secret.name],
        set: {
          valueCiphertext: input.valueCiphertext,
          keyCiphertext: input.keyCiphertext,
          keyId: input.keyId,
          hint: input.hint,
          updatedAt: new Date(),
        },
      })
      .returning(columns),
  );
  if (!row) throw new Error("secret upsert returned no row");
  return toRecord(row);
}

export async function findSecretByName(
  db: Database,
  ctx: TenantContext,
  name: string,
): Promise<SecretRecord | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select(columns).from(secret).where(eq(secret.name, name)).limit(1),
  );
  return row ? toRecord(row) : null;
}

export async function findSecretById(
  db: Database,
  ctx: TenantContext,
  id: SecretId,
): Promise<SecretRecord | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select(columns).from(secret).where(eq(secret.id, id)).limit(1),
  );
  return row ? toRecord(row) : null;
}

/** Every secret in the workspace, by name. */
export async function listSecrets(db: Database, ctx: TenantContext): Promise<SecretRecord[]> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx.select(columns).from(secret).orderBy(asc(secret.name)),
  );
  return rows.map(toRecord);
}

/** Returns false when no such secret exists. */
export async function deleteSecret(
  db: Database,
  ctx: TenantContext,
  id: SecretId,
): Promise<boolean> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx.delete(secret).where(eq(secret.id, id)).returning({ id: secret.id }),
  );
  return rows.length > 0;
}

export async function markSecretUsed(
  db: Database,
  ctx: TenantContext,
  id: SecretId,
): Promise<void> {
  await withTenant(db, ctx, (tx) =>
    tx
      .update(secret)
      // Using a secret is not an edit: keep `updated_at` as it was.
      .set({ lastUsedAt: new Date(), updatedAt: sql`${secret.updatedAt}` })
      .where(and(eq(secret.id, id), eq(secret.workspaceId, ctx.workspaceId))),
  );
}
