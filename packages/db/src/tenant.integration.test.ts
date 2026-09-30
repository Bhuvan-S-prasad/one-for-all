import { randomUUID } from "node:crypto";
import { asId, type TenantContext, type UserId, type WorkspaceId } from "@ofa/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "./env";
import {
  bootstrapOwner,
  createDatabase,
  isSetupComplete,
  listMembershipsForUser,
  schema,
  seedSampleData,
  withDatabaseName,
  withTenant,
} from "./index";

// Row-level security and tenant isolation (M1.12). Runs against the
// throwaway `oneforall_test_db` created by `pnpm test:integration`.
loadRootEnv();
const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL;

/** The Postgres error behind a failed query (Drizzle wraps it in `cause`). */
async function pgError(query: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await query;
  } catch (error) {
    return ((error as { cause?: unknown }).cause ?? error) as { code?: string; message: string };
  }
  throw new Error("expected the query to fail");
}

describe.skipIf(!appUrl || !ownerUrl)("tenant isolation (integration)", () => {
  // `app` is the role the product uses. `owner` is a superuser and bypasses
  // RLS; it is used only to create fixtures for a second workspace.
  const app = createDatabase(withDatabaseName(appUrl ?? "", "oneforall_test_db"), { max: 2 });
  const owner = createDatabase(withDatabaseName(ownerUrl ?? "", "oneforall_test_db"), { max: 1 });

  let a: TenantContext;
  let b: TenantContext;

  beforeAll(async () => {
    const setup = await bootstrapOwner(app.db, {
      workspaceName: "Workspace A",
      name: "Alice",
      email: "Alice@Example.com",
      passwordHash: "not-a-real-hash",
    });
    a = setup;
    await seedSampleData(app.db, a);

    // Workspace B, created directly as the owner role.
    const userB = asId<UserId>(randomUUID());
    const workspaceB = asId<WorkspaceId>(randomUUID());
    await owner.db.insert(schema.user).values({ id: userB, name: "Bob", email: "bob@example.com" });
    await owner.db.insert(schema.workspace).values({ id: workspaceB, name: "Workspace B" });
    await owner.db
      .insert(schema.membership)
      .values({ workspaceId: workspaceB, userId: userB, role: "owner" });
    b = { workspaceId: workspaceB, userId: userB };
    await seedSampleData(app.db, b);
  });

  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("first-run setup works once, then refuses", async () => {
    expect(await isSetupComplete(app.db)).toBe(true);
    await expect(
      bootstrapOwner(app.db, {
        workspaceName: "Again",
        name: "Mallory",
        email: "m@example.com",
        passwordHash: "x",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("stores the owner's email in lower case", async () => {
    const rows = await app.db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, a.userId));
    expect(rows[0]?.email).toBe("alice@example.com");
  });

  it("without a tenant, every tenant table looks empty", async () => {
    expect(await app.db.select().from(schema.workspace)).toHaveLength(0);
    expect(await app.db.select().from(schema.agent)).toHaveLength(0);
    expect(await app.db.select().from(schema.auditLog)).toHaveLength(0);
  });

  it("a tenant sees only its own rows", async () => {
    const agentsA = await withTenant(app.db, a, (tx) => tx.select().from(schema.agent));
    const agentsB = await withTenant(app.db, b, (tx) => tx.select().from(schema.agent));

    expect(agentsA.length).toBeGreaterThan(0);
    expect(agentsA.every((row) => row.workspaceId === a.workspaceId)).toBe(true);
    expect(agentsB.every((row) => row.workspaceId === b.workspaceId)).toBe(true);

    const idOfB = agentsB[0]?.id ?? "";
    const leaked = await withTenant(app.db, a, (tx) =>
      tx.select().from(schema.agent).where(eq(schema.agent.id, idOfB)),
    );
    expect(leaked).toHaveLength(0);
  });

  it("cannot write rows into another workspace", async () => {
    const error = await pgError(
      withTenant(app.db, a, (tx) =>
        tx.insert(schema.agent).values({ workspaceId: b.workspaceId, slug: "spy", name: "Spy" }),
      ),
    );
    expect(error.code).toBe("42501"); // new row violates row-level security policy
  });

  it("cannot update or delete another workspace's rows", async () => {
    const updated = await withTenant(app.db, a, (tx) =>
      tx
        .update(schema.agent)
        .set({ name: "Hijacked" })
        .where(eq(schema.agent.workspaceId, b.workspaceId))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const deleted = await withTenant(app.db, a, (tx) =>
      tx.delete(schema.workspace).where(eq(schema.workspace.id, b.workspaceId)).returning(),
    );
    expect(deleted).toHaveLength(0);
  });

  it("composite foreign keys stop references across workspaces", async () => {
    const [threadB] = await withTenant(app.db, b, (tx) =>
      tx.select({ id: schema.thread.id }).from(schema.thread),
    );
    expect(threadB).toBeDefined();

    // A message in workspace A that points at workspace B's thread.
    const error = await pgError(
      withTenant(app.db, a, (tx) =>
        tx.insert(schema.message).values({
          workspaceId: a.workspaceId,
          threadId: threadB?.id ?? "",
          authorType: "user",
          authorUserId: a.userId,
          content: "hello?",
        }),
      ),
    );
    expect(error.code).toBe("23503"); // foreign key violation
  });

  it("lists only the user's own memberships", async () => {
    const memberships = await listMembershipsForUser(app.db, a.userId);
    expect(memberships).toEqual([
      { workspaceId: a.workspaceId, workspaceName: "Workspace A", role: "owner" },
    ]);
  });

  it("tenant settings do not leak past the transaction", async () => {
    await withTenant(app.db, a, async () => {});
    const rows = await app.db.execute<{ ws: string | null }>(
      sql`select nullif(current_setting('app.workspace_id', true), '') as ws`,
    );
    expect(rows[0]?.ws ?? null).toBeNull();
  });

  it("run events and audit entries are append-only", async () => {
    const [runRow] = await withTenant(app.db, a, async (tx) => {
      const [agentRow] = await tx.select({ id: schema.agent.id }).from(schema.agent).limit(1);
      return tx
        .insert(schema.run)
        .values({ workspaceId: a.workspaceId, agentId: agentRow?.id ?? "", trigger: "manual" })
        .returning({ id: schema.run.id });
    });
    const runId = runRow?.id ?? "";
    await withTenant(app.db, a, (tx) =>
      tx
        .insert(schema.runEvent)
        .values({ workspaceId: a.workspaceId, runId, seq: 1, type: "run.started" }),
    );

    const attempts = [
      () =>
        withTenant(app.db, a, (tx) =>
          tx
            .update(schema.runEvent)
            .set({ type: "edited" })
            .where(eq(schema.runEvent.runId, runId)),
        ),
      () =>
        withTenant(app.db, a, (tx) =>
          tx.delete(schema.runEvent).where(eq(schema.runEvent.runId, runId)),
        ),
      () => withTenant(app.db, a, (tx) => tx.update(schema.auditLog).set({ action: "edited" })),
      () => withTenant(app.db, a, (tx) => tx.delete(schema.auditLog)),
    ];
    for (const attempt of attempts) {
      const error = await pgError(attempt());
      expect(error.code).toBe("42501");
      expect(error.message).toMatch(/append-only/);
    }
  });
});
