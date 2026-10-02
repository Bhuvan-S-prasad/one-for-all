import { randomBytes, randomUUID } from "node:crypto";
import { asId, type TenantContext, type UserId, type WorkspaceId } from "@ofa/core";
import { createDatabase, findSecretByName, loadRootEnv, schema, withDatabaseName } from "@ofa/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVault, REDACTED } from "./index";

// Runs against `oneforall_test_vault`, created by `pnpm test:integration`.
loadRootEnv();
const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL;

describe.skipIf(!appUrl || !ownerUrl)("vault (integration)", () => {
  const app = createDatabase(withDatabaseName(appUrl ?? "", "oneforall_test_vault"), { max: 2 });
  const owner = createDatabase(withDatabaseName(ownerUrl ?? "", "oneforall_test_vault"), {
    max: 1,
  });
  // A throwaway key for this run only.
  const key = randomBytes(32).toString("base64");
  const vault = createVault({ db: app.db, key });
  let a: TenantContext;
  let b: TenantContext;

  async function workspace(name: string): Promise<TenantContext> {
    const userId = asId<UserId>(randomUUID());
    const workspaceId = asId<WorkspaceId>(randomUUID());
    await owner.db.insert(schema.user).values({ id: userId, name, email: `${userId}@example.com` });
    await owner.db.insert(schema.workspace).values({ id: workspaceId, name });
    await owner.db.insert(schema.membership).values({ workspaceId, userId, role: "owner" });
    return { workspaceId, userId };
  }

  beforeAll(async () => {
    a = await workspace("A");
    b = await workspace("B");
  });

  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("stores ciphertext only and reveals the value", async () => {
    const value = "test-api-key-0000-1111-2222";
    const ref = await vault.put(a, "llm.test.api_key", value);
    const row = await findSecretByName(app.db, a, "llm.test.api_key");
    expect(JSON.stringify(row)).not.toContain(value);
    expect(row?.hint).toBe("…2222");
    expect(await vault.reveal(a, ref)).toBe(value);
    expect((await vault.list(a))[0]).toMatchObject({ name: "llm.test.api_key", hint: "…2222" });
  });

  it("another workspace can neither find nor reveal it", async () => {
    const ref = await vault.find(a, "llm.test.api_key");
    expect(ref).not.toBeNull();
    expect(await vault.find(b, "llm.test.api_key")).toBeNull();
    await expect(vault.reveal(b, ref ?? { id: asId(""), name: "" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("redacts the workspace's secrets, including one just replaced", async () => {
    expect(await vault.redact(a, "key test-api-key-0000-1111-2222")).toBe(`key ${REDACTED}`);
    await vault.put(a, "llm.test.api_key", "test-api-key-replaced-3333");
    expect(await vault.redact(a, "test-api-key-replaced-3333")).toBe(REDACTED);
    // B's redactor knows nothing about A's secrets.
    expect(await vault.redact(b, "test-api-key-replaced-3333")).toBe("test-api-key-replaced-3333");
  });

  it("refuses short values and bad names", async () => {
    await expect(vault.put(a, "short", "1234567")).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(vault.put(a, "Bad Name", "long-enough-value")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("deletes", async () => {
    const ref = await vault.find(a, "llm.test.api_key");
    if (!ref) throw new Error("missing secret");
    await vault.delete(a, ref);
    expect(await vault.find(a, "llm.test.api_key")).toBeNull();
  });
});
