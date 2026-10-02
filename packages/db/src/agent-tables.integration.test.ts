import { randomUUID } from "node:crypto";
import type { AgentSpec } from "@ofa/contracts";
import { asId, type TenantContext, type UserId, type WorkspaceId } from "@ofa/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "./env";
import {
  createDatabase,
  deleteSecret,
  findSecretByName,
  listSecrets,
  schema,
  upsertSecret,
  withDatabaseName,
  withTenant,
} from "./index";

// M2 tables: grants, tool calls, memory, secrets (M2.02). Uses its own
// database: tenant.integration.test.ts needs an install with no users yet.
loadRootEnv();
const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL;

const SPEC: AgentSpec = {
  job: "Research",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "calm",
  avatar: { form: "bloom", eyes: "googly", skin: "dots", color: "lilac", mark: "spark" },
  memoryScopes: ["agent", "workspace"],
  budgets: { steps: 40, tokens: 120_000 },
};

async function pgError(query: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await query;
  } catch (error) {
    return ((error as { cause?: unknown }).cause ?? error) as { code?: string; message: string };
  }
  throw new Error("expected the query to fail");
}

describe.skipIf(!appUrl || !ownerUrl)("agent tables (integration)", () => {
  const app = createDatabase(withDatabaseName(appUrl ?? "", "oneforall_test_agents"), { max: 2 });
  const owner = createDatabase(withDatabaseName(ownerUrl ?? "", "oneforall_test_agents"), {
    max: 1,
  });

  let ctx: TenantContext;
  let agentId: string;

  async function newRun(): Promise<string> {
    const [row] = await withTenant(app.db, ctx, (tx) =>
      tx
        .insert(schema.run)
        .values({ workspaceId: ctx.workspaceId, agentId, trigger: "manual" })
        .returning({ id: schema.run.id }),
    );
    return row?.id ?? "";
  }

  beforeAll(async () => {
    const userId = asId<UserId>(randomUUID());
    const workspaceId = asId<WorkspaceId>(randomUUID());
    await owner.db
      .insert(schema.user)
      .values({ id: userId, name: "Casey", email: `casey-${userId}@example.com` });
    await owner.db.insert(schema.workspace).values({ id: workspaceId, name: "Workspace C" });
    await owner.db.insert(schema.membership).values({ workspaceId, userId, role: "owner" });
    ctx = { workspaceId, userId };

    const [row] = await withTenant(app.db, ctx, (tx) =>
      tx
        .insert(schema.agent)
        .values({ workspaceId, slug: "researcher", name: "Researcher", spec: SPEC })
        .returning({ id: schema.agent.id }),
    );
    agentId = row?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("stores the agent spec as typed JSON", async () => {
    const [row] = await withTenant(app.db, ctx, (tx) =>
      tx.select({ spec: schema.agent.spec }).from(schema.agent).where(eq(schema.agent.id, agentId)),
    );
    expect(row?.spec).toEqual(SPEC);
  });

  it("grants are unique per tool and go with their agent", async () => {
    await withTenant(app.db, ctx, (tx) =>
      tx.insert(schema.agentGrant).values({
        workspaceId: ctx.workspaceId,
        agentId,
        tool: "web.search",
        mode: "auto",
      }),
    );
    const duplicate = await pgError(
      withTenant(app.db, ctx, (tx) =>
        tx.insert(schema.agentGrant).values({
          workspaceId: ctx.workspaceId,
          agentId,
          tool: "web.search",
          mode: "approve",
        }),
      ),
    );
    expect(duplicate.code).toBe("23505");
  });

  it("an idempotency key is used once per workspace", async () => {
    const runId = await newRun();
    const call = {
      workspaceId: ctx.workspaceId,
      runId,
      idempotencyKey: `${runId}:3`,
      tool: "web.search",
      args: { query: "pgvector" },
    };
    await withTenant(app.db, ctx, (tx) => tx.insert(schema.toolCall).values(call));
    const again = await withTenant(app.db, ctx, (tx) =>
      tx
        .insert(schema.toolCall)
        .values(call)
        .onConflictDoNothing({
          target: [schema.toolCall.workspaceId, schema.toolCall.idempotencyKey],
        })
        .returning({ id: schema.toolCall.id }),
    );
    expect(again).toHaveLength(0);
  });

  it("memory scope decides which owner columns are set", async () => {
    const base = { workspaceId: ctx.workspaceId, content: "Prefers short answers" };
    await withTenant(app.db, ctx, (tx) =>
      tx.insert(schema.memory).values([
        { ...base, scope: "workspace" },
        { ...base, scope: "agent", agentId },
        { ...base, scope: "agent_user", agentId, userId: ctx.userId, kind: "preference" },
      ]),
    );
    const wrong = await pgError(
      withTenant(app.db, ctx, (tx) =>
        tx.insert(schema.memory).values({ ...base, scope: "workspace", agentId }),
      ),
    );
    expect(wrong.code).toBe("23514"); // check violation
  });

  it("embeddings of any dimension round-trip, and always name their model", async () => {
    const [row] = await withTenant(app.db, ctx, (tx) =>
      tx
        .insert(schema.memory)
        .values({
          workspaceId: ctx.workspaceId,
          scope: "workspace",
          content: "The office is in Leeds",
          embedding: [0.25, -0.5, 1],
          embeddingModel: "test:tiny",
        })
        .returning({ embedding: schema.memory.embedding }),
    );
    expect(row?.embedding).toEqual([0.25, -0.5, 1]);

    const unnamed = await pgError(
      withTenant(app.db, ctx, (tx) =>
        tx.insert(schema.memory).values({
          workspaceId: ctx.workspaceId,
          scope: "workspace",
          content: "x",
          embedding: [1, 2],
        }),
      ),
    );
    expect(unnamed.code).toBe("23514");
  });

  it("deleting a run keeps the facts it taught", async () => {
    const runId = await newRun();
    const [fact] = await withTenant(app.db, ctx, (tx) =>
      tx
        .insert(schema.memory)
        .values({
          workspaceId: ctx.workspaceId,
          scope: "agent",
          agentId,
          content: "Learned in a run",
          sourceRunId: runId,
        })
        .returning({ id: schema.memory.id }),
    );
    await withTenant(app.db, ctx, (tx) => tx.delete(schema.run).where(eq(schema.run.id, runId)));
    const [kept] = await withTenant(app.db, ctx, (tx) =>
      tx
        .select({ sourceRunId: schema.memory.sourceRunId, workspaceId: schema.memory.workspaceId })
        .from(schema.memory)
        .where(eq(schema.memory.id, fact?.id ?? "")),
    );
    expect(kept).toEqual({ sourceRunId: null, workspaceId: ctx.workspaceId });
  });

  it("secrets: one per name, replaced on upsert, deleted by id", async () => {
    const write = {
      name: "llm.test.api_key",
      valueCiphertext: "v1.a",
      keyCiphertext: "v1.b",
      keyId: "k1",
      hint: "…1234",
    };
    const first = await upsertSecret(app.db, ctx, write);
    const second = await upsertSecret(app.db, ctx, { ...write, valueCiphertext: "v1.c" });
    expect(second.id).toBe(first.id);
    expect((await findSecretByName(app.db, ctx, write.name))?.valueCiphertext).toBe("v1.c");
    expect(await listSecrets(app.db, ctx)).toHaveLength(1);
    expect(await deleteSecret(app.db, ctx, first.id)).toBe(true);
    expect(await findSecretByName(app.db, ctx, write.name)).toBeNull();
  });
});
