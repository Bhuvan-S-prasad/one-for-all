import { randomBytes, randomUUID } from "node:crypto";
import { asId, type TenantContext, type UserId, type WorkspaceId } from "@ofa/core";
import {
  createDatabase,
  findSecretByName,
  loadRootEnv,
  schema,
  withDatabaseName,
  withTenant,
} from "@ofa/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVault, REDACTED, rotateInstall } from "./index";

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

  describe("rotation and connection records (M4.02)", () => {
    const newKey = randomBytes(32).toString("base64");
    const rotating = createVault({ db: app.db, key: newKey, previousKeys: [key] });
    const rotated = createVault({ db: app.db, key: newKey });
    let serverId = "";
    let connectionId = "";

    beforeAll(async () => {
      await vault.put(a, "rotation.test", "rotation-value-0001");
      await vault.put(b, "rotation.test", "rotation-value-0002");
      const [server] = await withTenant(app.db, a, (tx) =>
        tx
          .insert(schema.mcpServer)
          .values({
            workspaceId: a.workspaceId,
            slug: "notion",
            name: "Notion",
            url: "https://mcp.notion.example/mcp",
          })
          .returning({ id: schema.mcpServer.id }),
      );
      serverId = server?.id ?? "";
      const client = vault.seal(
        a,
        { table: "mcp_server", id: serverId },
        JSON.stringify({ client_id: "public-client-id", client_secret: "client-secret-5555" }),
      );
      await withTenant(app.db, a, (tx) =>
        tx
          .update(schema.mcpServer)
          .set({
            clientCiphertext: client.valueCiphertext,
            clientKeyCiphertext: client.keyCiphertext,
            clientKeyId: client.keyId,
          })
          .where(eq(schema.mcpServer.id, serverId)),
      );
      const [row] = await withTenant(app.db, a, (tx) =>
        tx
          .insert(schema.connection)
          .values({ workspaceId: a.workspaceId, mcpServerId: serverId, userId: a.userId })
          .returning({ id: schema.connection.id }),
      );
      connectionId = row?.id ?? "";
      const tokens = vault.seal(
        a,
        { table: "connection", id: connectionId },
        JSON.stringify({
          access_token: "access-token-6666",
          refresh_token: "refresh-token-7777",
          token_type: "Bearer",
        }),
      );
      await withTenant(app.db, a, (tx) =>
        tx
          .update(schema.connection)
          .set({
            status: "active",
            credentialsCiphertext: tokens.valueCiphertext,
            keyCiphertext: tokens.keyCiphertext,
            keyId: tokens.keyId,
          })
          .where(eq(schema.connection.id, connectionId)),
      );
    });

    async function storedTokens() {
      const [row] = await withTenant(app.db, a, (tx) =>
        tx.select().from(schema.connection).where(eq(schema.connection.id, connectionId)),
      );
      return {
        valueCiphertext: row?.credentialsCiphertext ?? "",
        keyCiphertext: row?.keyCiphertext ?? "",
        keyId: row?.keyId ?? "",
      };
    }

    it("redacts a connection's tokens and a server's client secret, not its ordinary fields", async () => {
      const fresh = createVault({ db: app.db, key });
      const text =
        "access-token-6666 refresh-token-7777 client-secret-5555 Bearer public-client-id";
      expect(await fresh.redact(a, text)).toBe(
        `${REDACTED} ${REDACTED} ${REDACTED} Bearer public-client-id`,
      );
    });

    it("a record's ciphertext opens only for its own row", async () => {
      const tokens = await storedTokens();
      expect(
        JSON.parse(vault.open(a, { table: "connection", id: connectionId }, tokens)),
      ).toMatchObject({
        access_token: "access-token-6666",
      });
      expect(() => vault.open(a, { table: "connection", id: serverId }, tokens)).toThrow();
      expect(() => vault.open(b, { table: "connection", id: connectionId }, tokens)).toThrow();
    });

    it("re-wraps every workspace's values once, keeping updated_at, after which the old key isn't needed", async () => {
      const before = await findSecretByName(app.db, a, "rotation.test");
      const result = await rotateInstall(rotating, owner.db);
      expect(result).toEqual({ workspaces: 2, rewrapped: 4, current: 0, unreadable: 0 });
      expect((await findSecretByName(app.db, a, "rotation.test"))?.updatedAt).toEqual(
        before?.updatedAt,
      );

      const ref = await rotated.find(a, "rotation.test");
      expect(await rotated.reveal(a, ref ?? { id: asId(""), name: "" })).toBe(
        "rotation-value-0001",
      );
      const tokens = await storedTokens();
      expect(rotated.open(a, { table: "connection", id: connectionId }, tokens)).toContain(
        "access-token-6666",
      );
      expect(await rotated.redact(a, "client-secret-5555")).toBe(REDACTED);
      // The old key alone no longer opens anything.
      await expect(vault.reveal(a, ref ?? { id: asId(""), name: "" })).rejects.toThrow(
        /no longer configured/,
      );

      expect(await rotateInstall(rotating, owner.db)).toEqual({
        workspaces: 2,
        rewrapped: 0,
        current: 4,
        unreadable: 0,
      });
    });

    it("leaves values it can't read alone, and still redacts", async () => {
      const stranger = createVault({ db: app.db, key: randomBytes(32).toString("base64") });
      expect(await stranger.rotate(a)).toEqual({ rewrapped: 0, current: 0, unreadable: 3 });
      expect(await stranger.redact(a, "nothing secret here")).toBe("nothing secret here");
    });
  });
});
