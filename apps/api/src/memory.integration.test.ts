import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import {
  episodeListSchema,
  memoryListSchema,
  sendMessageResponseSchema,
  skillListSchema,
  skillSchema,
  threadSchema,
  type MessageReceivedEvent,
} from "@ofa/contracts";
import { asId, type RunContext, type TenantContext, type ThreadId } from "@ofa/core";
import {
  createDatabase,
  listConsolidationCandidates,
  loadRootEnv,
  withDatabaseName,
} from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import {
  consolidateMemory,
  createMemoStepRunner,
  createScriptedLLM,
  learnFromRun,
  runAgent,
  type ScriptedReply,
} from "@ofa/harness";
import { createMemoryMaintenance } from "@ofa/memory";
import type { RunDispatcher } from "@ofa/orchestrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// Skills (M5.08) and memory (M5.09) against `oneforall_test_api_memory`:
// skills through the API and the agent's tools, `/slug` in a run, episodes,
// facts in their scopes, and a nightly pass over real rows.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

/** Plays the agent, the learning pass and the nightly pass, by what each is asked. */
const brain: ScriptedReply = (request) => {
  const prompt = request.messages.map((m) => m.content).join("\n");
  if (prompt.includes("You keep an AI agent's memory tidy")) {
    return {
      text: JSON.stringify({
        merge: [{ ids: ["f1", "f2"], fact: "Riley wants answers short and in bullet points." }],
        facts: ["Riley publishes the release digest every Friday."],
        skills: [
          {
            name: "Release digest",
            description: "When asked for the weekly release digest",
            steps: ["Collect the week's releases", "Write one line each", "Post the digest"],
          },
        ],
      }),
    };
  }
  if (prompt.includes('"episode": one sentence')) {
    return {
      text: JSON.stringify({
        episode: "Riley asked for a release digest; the agent wrote three lines.",
        facts: [
          { text: "Riley wants answers short.", about: "person" },
          { text: "The team ships releases on Fridays.", about: "team" },
          { text: "Answers should be in bullet points.", about: "work" },
        ],
      }),
    };
  }
  return { text: "- pgvector 0.9\n- Postgres 18.1\n- Inngest 1.3" };
};

describe.skipIf(!hasDb)("skills and memory (integration)", async () => {
  const base = loadConfig();
  const dbUrl = withDatabaseName(base.database.url, "oneforall_test_api_memory");
  const ownerUrl = withDatabaseName(base.database.migrationUrl, "oneforall_test_api_memory");
  const config = {
    ...base,
    database: { ...base.database, url: dbUrl, migrationUrl: ownerUrl },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
  };
  const llm = createScriptedLLM(Array.from({ length: 40 }, () => brain));
  const started: MessageReceivedEvent[] = [];
  const dispatcher: RunDispatcher = {
    messageReceived: async (event) => void started.push(event),
    cancelRun: async () => {},
    approvalDecided: async () => {},
    scheduleCreated: async () => {},
    consolidateMemory: async () => {},
    discussionStarted: async () => {},
    discussionStopped: async () => {},
    scheduleCancelled: async () => {},
  };
  const container = createContainer(config, {
    logger: createLogger({ level: "fatal", format: "json", write: () => {} }),
    bus: createMemoryEventBus(),
    llm,
    dispatcher,
  });
  const app = createApp(container);
  const handle = createDatabase(dbUrl, { max: 1 });
  const owner = createDatabase(ownerUrl, { max: 1 });
  const db = handle.db;
  afterAll(async () => {
    await container.close();
    await handle.close();
    await owner.close();
  });

  const origin = new URL(config.server.appUrl).origin;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response | Promise<Response>) => (await res).json();

  let tenant: TenantContext;
  let agentId = "";
  beforeAll(async () => {
    const res = await app.request(`${origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Archive",
        name: "Riley Owner",
        email: "riley@example.com",
        password: "correct-horse-battery",
      }),
    });
    expect(res.status).toBe(201);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const made = await send("POST", "/api/agents", {
      name: "Scribe",
      spec: {
        job: "Release notes",
        modelTier: "fast",
        voice: "brief",
        memoryScopes: ["agent", "workspace", "agent_user"],
        avatar: { form: "ghost", eyes: "lids", skin: "dots", color: "lilac", mark: "none" },
      },
      grants: [
        { tool: "run_skill", mode: "auto" },
        { tool: "save_skill", mode: "auto" },
      ],
    });
    expect(made.status).toBe(201);
    agentId = ((await made.json()) as { id: string }).id;
  });

  /** A person's message to Scribe, and the run context it starts. */
  async function ask(content: string) {
    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${agentId}/thread`)));
    const turn = sendMessageResponseSchema.parse(
      await json(send("POST", `/api/threads/${chat.id}/messages`, { content })),
    );
    const event = started.at(-1)!;
    tenant = { workspaceId: asId(event.workspaceId), userId: asId(event.userId) };
    const ctx: RunContext = { ...tenant, agentId: asId(agentId), runId: asId(turn.run!.id) };
    return { ctx, threadId: asId<ThreadId>(chat.id), messageId: turn.message.id };
  }
  const call = (ctx: RunContext, name: string, args: unknown, tainted = false, step = "tool-0-0") =>
    container.harness.tools.execute(
      { name, args, toolCallId: step, idempotencyKey: `${ctx.runId}:${step}`, tainted },
      ctx,
    );

  // ── Skills (M5.08) ────────────────────────────────────────────────────────

  it("keeps a person's skills, one per handle, shared or for one agent", async () => {
    const res = await send("POST", "/api/skills", {
      name: "Release digest",
      description: "The weekly digest of releases",
      steps: ["Collect the week's releases", "Write one line each"],
    });
    expect(res.status).toBe(201);
    const shared = skillSchema.parse(await res.json());
    expect(shared).toMatchObject({
      slug: "release-digest",
      agentId: null,
      status: "active",
      source: "person",
    });
    const again = await send("POST", "/api/skills", {
      name: "Release digest",
      description: "Another",
      steps: ["One", "Two"],
    });
    expect(again.status).toBe(409);
    const own = await send("POST", "/api/skills", {
      name: "Tidy notes",
      slug: "tidy",
      description: "Clean up meeting notes",
      steps: ["Fix headings", "Add action items"],
      agentId,
    });
    expect(own.status).toBe(201);
    const list = skillListSchema.parse(await json(send("GET", `/api/skills?agentId=${agentId}`)));
    expect(list.items.map((s) => s.slug)).toEqual(["release-digest", "tidy"]);
  });

  it("lets the agent save skills, as proposals after outside content, and use active ones", async () => {
    const { ctx } = await ask("Save how you did that");
    expect(
      await call(ctx, "save_skill", {
        name: "Changelog check",
        description: "Before a release",
        steps: ["Read the changelog", "List breaking changes"],
      }),
    ).toMatchObject({ status: "ok", content: expect.stringContaining("/changelog-check") });
    expect(
      await call(
        ctx,
        "save_skill",
        { name: "Inbox sweep", description: "Each morning", steps: ["Open the inbox", "Archive"] },
        true,
        "tool-1-0",
      ),
    ).toMatchObject({ status: "ok", content: expect.stringContaining("as a proposal") });
    const proposed = skillListSchema.parse(await json(send("GET", "/api/skills?status=proposed")));
    expect(proposed.items).toMatchObject([{ slug: "inbox-sweep", source: "agent", agentId }]);

    const tools = await container.harness.tools.listTools(ctx);
    const roster = tools.find((t) => t.name === "run_skill")?.description ?? "";
    expect(roster).toContain("changelog-check");
    expect(roster).not.toContain("inbox-sweep");
    // A person approves it; then the agent may use it.
    await send("PATCH", `/api/skills/${proposed.items[0]!.id}`, { status: "active" });
    expect(await call(ctx, "run_skill", { skill: "inbox-sweep" }, false, "tool-2-0")).toMatchObject(
      {
        status: "ok",
        content: expect.stringContaining("1. Open the inbox"),
      },
    );
  });

  // ── A run, its episode and what it learned (M5.08–09) ─────────────────────

  it("applies /release-digest, writes an episode and learns facts into their scopes", async () => {
    const { ctx, threadId, messageId } = await ask("/release-digest for this week, please");
    const before = llm.requests.length;
    const result = await runAgent(
      { ctx, threadId, trigger: "message", requestId: messageId },
      container.harness,
      createMemoStepRunner(),
    );
    expect(result.status).toBe("succeeded");
    const system = llm.requests[before]?.messages[0]?.content ?? "";
    expect(system).toContain('The request names your skill "Release digest" (/release-digest).');
    expect(system).toContain("2. Write one line each");

    let episodes = episodeListSchema.parse(
      await json(send("GET", `/api/memories/episodes?agentId=${agentId}`)),
    );
    expect(episodes.items[0]).toMatchObject({
      runId: ctx.runId,
      outcome: "done",
      summary: expect.stringMatching(
        /^Asked: \/release-digest for this week, please — Answered: - pgvector/,
      ),
    });

    await learnFromRun(
      { ctx, threadId, messageId: asId(result.messageId!) },
      container.harness,
      createMemoStepRunner(),
    );
    episodes = episodeListSchema.parse(
      await json(send("GET", `/api/memories/episodes?agentId=${agentId}`)),
    );
    expect(episodes.items[0]?.summary).toBe(
      "Riley asked for a release digest; the agent wrote three lines.",
    );
    const facts = memoryListSchema.parse(
      await json(send("GET", `/api/memories?agentId=${agentId}`)),
    );
    expect(Object.fromEntries(facts.items.map((m) => [m.content, m.scope]))).toEqual({
      "Riley wants answers short.": "agent_user",
      "The team ships releases on Fridays.": "workspace",
      "Answers should be in bullet points.": "agent",
    });
  });

  // ── The nightly pass (M5.09) ──────────────────────────────────────────────

  it("is due at 3 at night in the workspace's zone, once a day", async () => {
    const maintenance = createMemoryMaintenance(db, {
      candidates: () => listConsolidationCandidates(owner.db),
    });
    const night = new Date("2026-10-12T03:20:00Z");
    expect(await maintenance.listDue(night)).toEqual([
      { workspaceId: tenant.workspaceId, userId: tenant.userId },
    ]);
    expect(await maintenance.listDue(new Date("2026-10-12T14:20:00Z"))).toEqual([]);
    await send("PUT", "/api/settings/workspace", { timeZone: "Asia/Kolkata" });
    // 03:20 in Kolkata is 21:50 UTC the evening before.
    expect(await maintenance.listDue(night)).toEqual([]);
    expect(await maintenance.listDue(new Date("2026-10-11T21:50:00Z"))).toHaveLength(1);
    await maintenance.finish(tenant, new Date("2026-10-11T21:50:00Z"));
    expect(await maintenance.listDue(new Date("2026-10-11T22:10:00Z"))).toEqual([]);
  });

  it("merges facts, adds what the work shows, proposes a skill and expires what is stale", async () => {
    const maintenance = createMemoryMaintenance(db, {
      candidates: () => listConsolidationCandidates(owner.db),
    });
    // A fact nobody confirmed.
    const { ctx } = await ask("Remember this");
    await container.memory.write(ctx, {
      scope: "agent",
      kind: "fact",
      content: "Riley once mentioned a vendor.",
      verified: false,
    });

    const now = new Date();
    const result = await consolidateMemory(
      { ctx: tenant, agentId, now },
      { llm, maintenance },
      createMemoStepRunner(),
    );
    expect(result).toMatchObject({ merged: 1, added: 1, proposedSkills: 0, modelCalls: 1 });
    // The proposed skill's handle (release-digest) is a person's skill already.
    const facts = memoryListSchema.parse(
      await json(send("GET", `/api/memories?agentId=${agentId}`)),
    );
    const contents = facts.items.map((m) => m.content);
    expect(contents).toContain("Riley wants answers short and in bullet points.");
    expect(contents).toContain("Riley publishes the release digest every Friday.");
    // The call was shown the unconfirmed fact, so the new one waits for a person too (ADR-0037).
    const added = facts.items.find((m) => m.content.startsWith("Riley publishes"));
    expect(added?.verified).toBe(false);
    expect(await maintenance.newEpisodes(tenant, agentId, 10)).toEqual([]);

    // Forty days on, neither was confirmed: both expire; confirmed facts stay.
    const later = new Date(now.getTime() + 40 * 24 * 60 * 60_000);
    expect(await maintenance.expireStale(tenant, later)).toBe(2);
    const after = memoryListSchema.parse(
      await json(send("GET", `/api/memories?agentId=${agentId}`)),
    );
    const left = after.items.map((m) => m.content);
    expect(left).not.toContain("Riley once mentioned a vendor.");
    expect(left).toContain("Riley wants answers short and in bullet points.");
  });

  it("proposes a new skill for a person to approve", async () => {
    const taken = skillListSchema
      .parse(await json(send("GET", "/api/skills")))
      .items.find((s) => s.slug === "release-digest")!;
    expect((await send("DELETE", `/api/skills/${taken.id}`)).status).toBe(204);
    const maintenance = createMemoryMaintenance(db, {
      candidates: () => listConsolidationCandidates(owner.db),
    });
    // New work to read: one more answered run.
    const { ctx, threadId, messageId } = await ask("Another digest, please");
    await runAgent(
      { ctx, threadId, trigger: "message", requestId: messageId },
      container.harness,
      createMemoStepRunner(),
    );
    const result = await consolidateMemory(
      { ctx: tenant, agentId, now: new Date() },
      { llm, maintenance },
      createMemoStepRunner(),
    );
    expect(result.proposedSkills).toBe(1);
    const proposed = skillListSchema.parse(await json(send("GET", "/api/skills?status=proposed")));
    expect(proposed.items.map((s) => [s.slug, s.source])).toContainEqual([
      "release-digest",
      "consolidation",
    ]);
  });
});
