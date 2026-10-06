import { randomUUID } from "node:crypto";
import type { AgentSpec } from "@ofa/contracts";
import {
  asId,
  type RunContext,
  type TenantContext,
  type UserId,
  type WorkspaceId,
} from "@ofa/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRootEnv } from "./env";
import {
  createApprovalStore,
  createDatabase,
  createPolicyRule,
  createPolicyRuleStore,
  createRunStore,
  createThreadStore,
  createToolCallStore,
  deleteSecret,
  findSecretByName,
  listPolicyRules,
  listSecrets,
  schema,
  setPolicyRuleEnabled,
  upsertSecret,
  withDatabaseName,
  withTenant,
  type PolicyRuleInput,
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

  describe("connections and policy rules (M4.01)", () => {
    async function newServer(
      slug: string,
      extra: Partial<typeof schema.mcpServer.$inferInsert> = {},
    ) {
      const [row] = await withTenant(app.db, ctx, (tx) =>
        tx
          .insert(schema.mcpServer)
          .values({
            workspaceId: ctx.workspaceId,
            slug,
            name: slug,
            url: `https://mcp.${slug}.example/mcp`,
            ...extra,
          })
          .returning({ id: schema.mcpServer.id }),
      );
      return row?.id ?? "";
    }

    it("servers: one slug and one install of a catalog entry per workspace", async () => {
      await newServer("notion", { catalogId: "notion" });
      expect((await pgError(newServer("notion"))).code).toBe("23505");
      expect((await pgError(newServer("notion2", { catalogId: "notion" }))).code).toBe("23505");
      // Custom servers have no catalog entry, and there can be several.
      await newServer("custom_a");
      await newServer("custom_b");
    });

    it("servers: refuse a slug that can't prefix tool names, and a half-stored client", async () => {
      expect((await pgError(newServer("Not-OK"))).code).toBe("23514");
      const half = await pgError(
        newServer("half", { clientCiphertext: "v1.a", clientKeyId: "k1" }),
      );
      expect(half.code).toBe("23514");
      await newServer("whole", {
        clientCiphertext: "v1.a",
        clientKeyCiphertext: "v1.b",
        clientKeyId: "k1",
      });
    });

    it("connections: one per person per server, active only with credentials, gone with the server", async () => {
      const mcpServerId = await newServer("linear");
      const base = { workspaceId: ctx.workspaceId, mcpServerId, userId: ctx.userId };
      const empty = await pgError(
        withTenant(app.db, ctx, (tx) =>
          tx.insert(schema.connection).values({ ...base, status: "active" }),
        ),
      );
      expect(empty.code).toBe("23514");
      await withTenant(app.db, ctx, (tx) =>
        tx.insert(schema.connection).values({
          ...base,
          status: "active",
          credentialsCiphertext: "v1.a",
          keyCiphertext: "v1.b",
          keyId: "k1",
        }),
      );
      const second = await pgError(
        withTenant(app.db, ctx, (tx) => tx.insert(schema.connection).values(base)),
      );
      expect(second.code).toBe("23505");

      await withTenant(app.db, ctx, (tx) =>
        tx.delete(schema.mcpServer).where(eq(schema.mcpServer.id, mcpServerId)),
      );
      const left = await withTenant(app.db, ctx, (tx) =>
        tx.select().from(schema.connection).where(eq(schema.connection.mcpServerId, mcpServerId)),
      );
      expect(left).toHaveLength(0);
    });

    it("connections: can't point at another workspace's server", async () => {
      const mcpServerId = await newServer("github");
      const otherId = asId<WorkspaceId>(randomUUID());
      await owner.db.insert(schema.workspace).values({ id: otherId, name: "Workspace D" });
      await owner.db
        .insert(schema.membership)
        .values({ workspaceId: otherId, userId: ctx.userId, role: "owner" });
      const other: TenantContext = { workspaceId: otherId, userId: ctx.userId };

      const visible = await withTenant(app.db, other, (tx) =>
        tx.select().from(schema.mcpServer).where(eq(schema.mcpServer.id, mcpServerId)),
      );
      expect(visible).toHaveLength(0);
      const crossed = await pgError(
        withTenant(app.db, other, (tx) =>
          tx
            .insert(schema.connection)
            .values({ workspaceId: otherId, mcpServerId, userId: ctx.userId }),
        ),
      );
      expect(crossed.code).toBe("23503"); // foreign key violation
    });

    it("policy rules: personal rules only tighten, and each rule exists once", async () => {
      const rule = (extra: Partial<typeof schema.policyRule.$inferInsert>) =>
        withTenant(app.db, ctx, (tx) =>
          tx.insert(schema.policyRule).values({
            workspaceId: ctx.workspaceId,
            tool: "gmail.send",
            effect: "ask_first",
            ...extra,
          }),
        );
      await rule({});
      await rule({ userId: ctx.userId });
      await rule({ tool: "web.*", effect: "allow_auto" });
      await rule({ tool: "remember", effect: "allow_auto", agentId });

      expect((await pgError(rule({ userId: ctx.userId, effect: "allow_auto" }))).code).toBe(
        "23514",
      );
      // No user and no agent still counts as the same rule.
      expect((await pgError(rule({}))).code).toBe("23505");
      for (const tool of ["Gmail.send", "gmail.", "*.send", "gmail send"]) {
        expect((await pgError(rule({ tool }))).code).toBe("23514");
      }
    });

    it("policy rules: an agent's rules go with the agent", async () => {
      const [other] = await withTenant(app.db, ctx, (tx) =>
        tx
          .insert(schema.agent)
          .values({ workspaceId: ctx.workspaceId, slug: "mailer", name: "Mailer", spec: SPEC })
          .returning({ id: schema.agent.id }),
      );
      const otherAgent = other?.id ?? "";
      await withTenant(app.db, ctx, (tx) =>
        tx.insert(schema.policyRule).values({
          workspaceId: ctx.workspaceId,
          agentId: otherAgent,
          tool: "*",
          effect: "ask_first",
        }),
      );
      await withTenant(app.db, ctx, (tx) =>
        tx.delete(schema.agent).where(eq(schema.agent.id, otherAgent)),
      );
      const left = await withTenant(app.db, ctx, (tx) =>
        tx.select().from(schema.policyRule).where(eq(schema.policyRule.agentId, otherAgent)),
      );
      expect(left).toHaveLength(0);
    });
  });

  describe("policy rules and site answers (M4.07)", () => {
    it("a run sees enabled rules for its agent or all, the workspace's and its person's own", async () => {
      const otherUser = asId<UserId>(randomUUID());
      await owner.db
        .insert(schema.user)
        .values({ id: otherUser, name: "Dana", email: `dana-${otherUser}@example.com` });
      const [otherAgent] = await withTenant(app.db, ctx, (tx) =>
        tx
          .insert(schema.agent)
          .values({ workspaceId: ctx.workspaceId, slug: "scout", name: "Scout", spec: SPEC })
          .returning({ id: schema.agent.id }),
      );
      const add = (input: Partial<PolicyRuleInput> & Pick<PolicyRuleInput, "tool">) =>
        createPolicyRule(app.db, ctx, {
          effect: "ask_first",
          scope: "workspace",
          agentId: null,
          description: "",
          ...input,
        });
      await add({ tool: "rules.everyone" });
      await add({ tool: "rules.mine", scope: "personal" });
      await add({ tool: "rules.this_agent", agentId });
      await add({ tool: "rules.other_agent", agentId: otherAgent?.id ?? null });
      const off = await add({ tool: "rules.disabled" });
      await setPolicyRuleEnabled(app.db, ctx, off?.id ?? "", false);
      // Someone else's personal rule, written as them.
      await createPolicyRule(
        app.db,
        { ...ctx, userId: otherUser },
        {
          tool: "rules.theirs",
          effect: "ask_first",
          scope: "personal",
          agentId: null,
          description: "",
        },
      );
      expect(await add({ tool: "rules.everyone" })).toBeNull(); // already there

      const store = createPolicyRuleStore(app.db);
      const seen = await store.listForRun({
        ...ctx,
        agentId: asId(agentId),
        runId: asId(randomUUID()),
      });
      expect(
        seen
          .map((r) => r.tool)
          .filter((t) => t.startsWith("rules."))
          .sort(),
      ).toEqual(["rules.everyone", "rules.mine", "rules.this_agent"]);
      expect(seen.find((r) => r.tool === "rules.mine")?.scope).toBe("personal");
      // The list for Settings: the workspace's and mine, never theirs.
      const listed = (await listPolicyRules(app.db, ctx)).map((r) => r.tool);
      expect(listed).toContain("rules.disabled");
      expect(listed).not.toContain("rules.theirs");
    });

    it("an approval can be answered for its site only if it names one", async () => {
      const runId = await newRun();
      const rc: RunContext = { ...ctx, agentId: asId(agentId), runId: asId(runId) };
      const approvals = createApprovalStore(app.db);
      const input = {
        tool: "browser.click",
        args: {},
        summary: "Click",
        reasons: [],
        verdict: "approve" as const,
        expiresAt: new Date(Date.now() + 60_000),
      };
      const withSite = await approvals.request(rc, {
        ...input,
        toolCallId: "tool-0-0",
        site: "shop.example",
      });
      const without = await approvals.request(rc, { ...input, toolCallId: "tool-1-0" });
      expect(withSite).toMatchObject({ site: "shop.example", scope: "once" });
      const decided = await approvals.decide(ctx, withSite.id, {
        status: "approved",
        decidedBy: ctx.userId,
        scope: "site",
      });
      expect(decided?.scope).toBe("site");
      const plain = await approvals.decide(ctx, without.id, {
        status: "approved",
        decidedBy: ctx.userId,
        scope: "site",
      });
      expect(plain?.scope).toBe("once");
    });
  });

  describe("runtime stores", () => {
    const published: unknown[] = [];
    const publish = async (_ws: string, payload: unknown) => void published.push(payload);
    const runs = createRunStore(app.db, { publish: publish as never });

    async function runCtx(): Promise<RunContext> {
      return { ...ctx, agentId: asId(agentId), runId: asId(await newRun()) };
    }

    it("appends in order, skips repeated keys, and announces each event", async () => {
      const rc = await runCtx();
      published.length = 0;
      await runs.append(rc, rc.runId, [
        { key: "a", type: "run.started", payload: {} },
        { key: "b", type: "run.resumed", payload: {} },
      ]);
      await runs.append(rc, rc.runId, [
        { key: "b", type: "run.resumed", payload: {} },
        { key: "c", type: "run.resumed", payload: {} },
      ]);
      const rows = await withTenant(app.db, ctx, (tx) =>
        tx.select().from(schema.runEvent).where(eq(schema.runEvent.runId, rc.runId)),
      );
      expect(rows.map((r) => [r.seq, r.key]).sort()).toEqual([
        [0, "a"],
        [1, "b"],
        [2, "c"],
      ]);
      expect(published).toHaveLength(3);
    });

    const keysOf = async (runId: string) =>
      (
        await withTenant(app.db, ctx, (tx) =>
          tx
            .select({ key: schema.runEvent.key })
            .from(schema.runEvent)
            .where(eq(schema.runEvent.runId, runId))
            .orderBy(schema.runEvent.seq),
        )
      ).map((r) => r.key);

    it("closes the log once the run has ended, except for run.ended", async () => {
      const rc = await runCtx();
      await runs.update(rc, rc.runId, { status: "cancelled" });
      await runs.append(rc, rc.runId, [
        { key: "late", type: "tool.completed", payload: {} },
        { key: "learn-model", type: "model.called", payload: {} },
        { key: "end", type: "run.ended", payload: {} },
      ]);
      expect(await keysOf(rc.runId)).toEqual(["end"]);
    });

    it("lets a succeeded run's learning pass add to its closed log", async () => {
      const rc = await runCtx();
      await runs.update(rc, rc.runId, { status: "succeeded" });
      await runs.append(rc, rc.runId, [
        { key: "late", type: "tool.completed", payload: {} },
        { key: "learn-model", type: "model.called", payload: {} },
      ]);
      expect(await keysOf(rc.runId)).toEqual(["learn-model"]);
    });

    it("leaves an ended run's status alone when asked", async () => {
      const rc = await runCtx();
      await runs.update(rc, rc.runId, { status: "cancelled" });
      await runs.update(rc, rc.runId, { status: "succeeded", onlyIfActive: true });
      await runs.update(rc, rc.runId, { status: "running", onlyIfStatus: "waiting" });
      expect((await runs.get(rc, rc.runId))?.status).toBe("cancelled");
    });

    it("posts one reply per run, even when the step is retried", async () => {
      const rc = await runCtx();
      const [t] = await withTenant(app.db, ctx, (tx) =>
        tx
          .insert(schema.thread)
          .values({ workspaceId: ctx.workspaceId })
          .returning({ id: schema.thread.id }),
      );
      const threads = createThreadStore(app.db);
      const first = await threads.addAgentMessage(rc, {
        threadId: asId(t?.id ?? ""),
        content: "Hi",
      });
      const again = await threads.addAgentMessage(rc, {
        threadId: asId(t?.id ?? ""),
        content: "Hi",
      });
      expect(again).toBe(first);
      expect(await threads.recentMessages(ctx, asId(t?.id ?? ""), 10)).toHaveLength(1);
    });

    it("records a tool call once and returns the stored result after", async () => {
      const rc = await runCtx();
      const calls = createToolCallStore(app.db);
      const input = {
        idempotencyKey: `${rc.runId}:tool-0-0`,
        tool: "web.search",
        args: { q: "x" },
        verdict: "auto" as const,
      };
      expect(await calls.begin(rc, input)).toEqual({ created: true });
      await calls.complete(rc, input.idempotencyKey, { result: "found", untrusted: true });
      expect(await calls.begin(rc, input)).toEqual({
        created: false,
        existing: { status: "done", result: "found", untrusted: true },
      });
    });
  });
});
