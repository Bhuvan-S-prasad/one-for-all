import { randomUUID } from "node:crypto";
import { asId, type RunContext, type UserId, type WorkspaceId } from "@ofa/core";
import { createDatabase, loadRootEnv, schema, withDatabaseName, withTenant } from "@ofa/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgMemoryStore } from "./index";

// Runs against `oneforall_test_memory`, created by `pnpm test:integration`.
loadRootEnv();
const appUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL;

describe.skipIf(!appUrl || !ownerUrl)("memory store (integration)", () => {
  const app = createDatabase(withDatabaseName(appUrl ?? "", "oneforall_test_memory"), { max: 2 });
  const owner = createDatabase(withDatabaseName(ownerUrl ?? "", "oneforall_test_memory"), {
    max: 1,
  });
  const store = createPgMemoryStore(app.db);
  let scout: RunContext;
  let inbox: RunContext;

  beforeAll(async () => {
    const userId = asId<UserId>(randomUUID());
    const workspaceId = asId<WorkspaceId>(randomUUID());
    await owner.db
      .insert(schema.user)
      .values({ id: userId, name: "Sam", email: `${userId}@example.com` });
    await owner.db.insert(schema.workspace).values({ id: workspaceId, name: "W" });
    await owner.db.insert(schema.membership).values({ workspaceId, userId, role: "owner" });
    const avatar = {
      form: "bloom",
      eyes: "googly",
      skin: "dots",
      color: "lilac",
      mark: "none",
    } as const;
    const spec = {
      job: "x",
      modelTier: "fast",
      role: "specialist",
      autonomy: "suggest",
      voice: "calm",
      avatar,
      memoryScopes: ["agent", "workspace"],
      budgets: { steps: 5, tokens: 10_000 },
    } as const;
    const agents = await withTenant(app.db, { workspaceId, userId }, (tx) =>
      tx
        .insert(schema.agent)
        .values([
          {
            workspaceId,
            slug: "scout",
            name: "Scout",
            spec: { ...spec, memoryScopes: [...spec.memoryScopes] },
          },
          {
            workspaceId,
            slug: "inbox",
            name: "Inbox",
            spec: { ...spec, memoryScopes: [...spec.memoryScopes] },
          },
        ])
        .returning({ id: schema.agent.id }),
    );
    const run = async (agentId: string) => {
      const [row] = await withTenant(app.db, { workspaceId, userId }, (tx) =>
        tx
          .insert(schema.run)
          .values({ workspaceId, agentId, trigger: "manual" })
          .returning({ id: schema.run.id }),
      );
      return row?.id ?? "";
    };
    scout = {
      workspaceId,
      userId,
      agentId: asId(agents[0]?.id ?? ""),
      runId: asId(await run(agents[0]?.id ?? "")),
    };
    inbox = {
      workspaceId,
      userId,
      agentId: asId(agents[1]?.id ?? ""),
      runId: asId(await run(agents[1]?.id ?? "")),
    };
  });

  afterAll(async () => {
    await app.close();
    await owner.close();
  });

  it("finds facts by any matching word, with stemming", async () => {
    await store.write(scout, {
      scope: "agent",
      kind: "preference",
      content: "Sam prefers weekly summaries",
      verified: true,
    });
    const found = await store.recall(scout, {
      query: "What summary does Sam want?",
      scopes: ["agent"],
      limit: 5,
    });
    expect(found.map((m) => m.content)).toEqual(["Sam prefers weekly summaries"]);
  });

  it("keeps agent memory private to its agent; workspace memory is shared", async () => {
    await store.write(scout, {
      scope: "workspace",
      kind: "fact",
      content: "The office moved to Leeds",
      verified: true,
    });
    expect(
      await store.recall(inbox, {
        query: "Sam summaries",
        scopes: ["agent", "workspace"],
        limit: 5,
      }),
    ).toEqual([]);
    const shared = await store.recall(inbox, {
      query: "office Leeds",
      scopes: ["agent", "workspace"],
      limit: 5,
    });
    expect(shared.map((m) => m.content)).toEqual(["The office moved to Leeds"]);
  });

  it("hides unverified facts unless asked for them", async () => {
    await store.write(scout, {
      scope: "agent",
      kind: "fact",
      content: "The budget is ten thousand",
      verified: false,
    });
    expect(await store.recall(scout, { query: "budget", scopes: ["agent"], limit: 5 })).toEqual([]);
    const all = await store.recall(scout, {
      query: "budget",
      scopes: ["agent"],
      limit: 5,
      includeUnverified: true,
    });
    expect(all).toMatchObject([{ verified: false }]);
  });

  it("stores the same fact once", async () => {
    const a = await store.write(scout, {
      scope: "agent",
      kind: "fact",
      content: "Likes  tea",
      verified: true,
    });
    const b = await store.write(scout, {
      scope: "agent",
      kind: "fact",
      content: "likes tea",
      verified: true,
    });
    expect(b.id).toBe(a.id);
  });

  it("returns recent facts when the query has no usable words", async () => {
    const recent = await store.recall(scout, { query: "?!", scopes: ["agent"], limit: 2 });
    expect(recent).toHaveLength(2);
  });
});
