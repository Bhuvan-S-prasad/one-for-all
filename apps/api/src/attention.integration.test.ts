import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import {
  agentFileSchema,
  importAgentResponseSchema,
  messagePageSchema,
  routineSchema,
  runSchema,
  sendMessageResponseSchema,
  skillListSchema,
  threadSchema,
  unreadListSchema,
  type MessageReceivedEvent,
} from "@ofa/contracts";
import { asId, type RunContext, type RunId, type TenantContext, type ThreadId } from "@ofa/core";
import { loadRootEnv, withDatabaseName } from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import { createMemoStepRunner, createScriptedLLM, runAgent } from "@ofa/harness";
import type { RunDispatcher } from "@ofa/orchestrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// Proactive checks (M5.10), unread chats (M5.11) and agents as files (M5.12)
// against `oneforall_test_api_attention`, through the real API and stores.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("checks, unread and agent files (integration)", async () => {
  const base = loadConfig();
  const config = {
    ...base,
    database: {
      ...base.database,
      url: withDatabaseName(base.database.url, "oneforall_test_api_attention"),
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_attention"),
    },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
  };
  const llm = createScriptedLLM([]);
  const started: MessageReceivedEvent[] = [];
  const dispatcher: RunDispatcher = {
    messageReceived: async (event) => void started.push(event),
    cancelRun: async () => {},
    approvalDecided: async () => {},
    scheduleCreated: async () => {},
    consolidateMemory: async () => {},
    scheduleCancelled: async () => {},
  };
  const container = createContainer(config, {
    logger: createLogger({ level: "fatal", format: "json", write: () => {} }),
    bus: createMemoryEventBus(),
    llm,
    dispatcher,
  });
  const app = createApp(container);
  afterAll(async () => {
    await container.close();
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
  let watcherId = "";
  let helperId = "";
  beforeAll(async () => {
    const res = await app.request(`${origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Lookout",
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
    const hatch = async (name: string, grants: { tool: string; mode: string }[]) => {
      const made = await send("POST", "/api/agents", {
        name,
        spec: {
          job: "Keeps watch",
          modelTier: "fast",
          voice: "brief",
          avatar: { form: "drop", eyes: "cyclops", skin: "solid", color: "cobalt", mark: "horns" },
        },
        grants,
      });
      expect(made.status).toBe(201);
      return ((await made.json()) as { id: string }).id;
    };
    watcherId = await hatch("Sentinel", [
      { tool: "recall", mode: "auto" },
      { tool: "remember", mode: "auto" },
    ]);
    helperId = await hatch("Helper", []);
    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${helperId}/thread`)));
    await send("POST", `/api/threads/${chat.id}/messages`, { content: "Hello" });
    const event = started.at(-1)!;
    tenant = { workspaceId: asId(event.workspaceId), userId: asId(event.userId) };
  });

  // ── Unread (M5.11) ────────────────────────────────────────────────────────

  it("counts agent messages you haven't seen, per chat, until you read it", async () => {
    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${helperId}/thread`)));
    const run = started.at(-1)!;
    const ctx: RunContext = { ...tenant, agentId: asId(helperId), runId: asId(run.runId) };
    await container.threads.addAgentMessage(ctx, {
      threadId: asId<ThreadId>(chat.id),
      content: "Hi! How can I help?",
    });
    let unread = unreadListSchema.parse(await json(send("GET", "/api/threads/unread")));
    expect(unread.items).toMatchObject([
      { threadId: chat.id, kind: "direct", agentIds: [helperId], unread: 1 },
    ]);
    expect((await send("POST", `/api/threads/${chat.id}/read`)).status).toBe(204);
    unread = unreadListSchema.parse(await json(send("GET", "/api/threads/unread")));
    expect(unread.items).toEqual([]);
  });

  // ── Proactive checks (M5.10) ──────────────────────────────────────────────

  it("runs a check read-only, posting nothing to start and nothing when all is quiet", async () => {
    const made = await send("POST", "/api/routines", {
      agentId: watcherId,
      name: "Release watch",
      instructions: "Look for a new pgvector release.",
      kind: "check",
      cron: "0 * * * *",
    });
    expect(made.status).toBe(201);
    const routine = routineSchema.parse(await made.json());
    expect(routine.kind).toBe("check");

    const run = runSchema.parse(await json(send("POST", `/api/routines/${routine.id}/run`)));
    const record = await container.runs.get(tenant, asId<RunId>(run.id));
    expect(record).toMatchObject({
      proactive: true,
      request: "Check “Release watch”: Look for a new pgvector release.",
    });
    expect(started.at(-1)).toMatchObject({ runId: run.id, messageId: run.id, trigger: "manual" });
    const before = messagePageSchema.parse(
      await json(send("GET", `/api/threads/${routine.threadId}/messages`)),
    );
    expect(before.items).toEqual([]);

    // What the agent sees, and its quiet answer.
    const ctx: RunContext = { ...tenant, agentId: asId(watcherId), runId: asId(run.id) };
    const tools = await container.harness.tools.listTools(ctx, { readOnly: true });
    // Only what reads: its granted recall and the platform's artifacts.read.
    expect(tools.map((t) => t.name).sort()).toEqual(["artifacts.read", "recall"]);
    const refused = await container.harness.tools.execute(
      {
        name: "remember",
        args: { fact: "The owner likes quiet checks." },
        toolCallId: "tool-0-0",
        idempotencyKey: `${run.id}:tool-0-0`,
        tainted: false,
        readOnly: true,
      },
      ctx,
    );
    expect(refused).toMatchObject({ status: "blocked", verdict: "deny" });

    const quiet = createScriptedLLM([{ text: "NOTHING_TO_REPORT" }]);
    const result = await runAgent(
      { ctx, threadId: asId<ThreadId>(routine.threadId), trigger: "manual", requestId: run.id },
      { ...container.harness, llm: quiet },
      createMemoStepRunner(),
    );
    expect(result).toMatchObject({ status: "succeeded", messageId: null });
    expect(quiet.requests[0]?.messages.at(-1)?.content).toContain("background checks");
    const after = messagePageSchema.parse(
      await json(send("GET", `/api/threads/${routine.threadId}/messages`)),
    );
    expect(after.items).toEqual([]);
  });

  // ── Agents as files (M5.12) ───────────────────────────────────────────────

  it("exports an agent with its own skills and routines, and imports it as a new one held for review", async () => {
    await send("POST", "/api/skills", {
      name: "Release check",
      slug: "release-check",
      description: "Look at the changelog for breaking changes",
      steps: ["Open the changelog", "List breaking changes"],
      agentId: watcherId,
    });
    const res = await send("GET", `/api/agents/${watcherId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="sentinel.agent.json"',
    );
    const file = agentFileSchema.parse(await res.json());
    expect(file).toMatchObject({
      format: "one-for-all/agent",
      version: 1,
      agent: { name: "Sentinel", slug: "sentinel" },
      skills: [{ slug: "release-check" }],
      routines: [{ name: "Release watch", kind: "check", cron: "0 * * * *" }],
    });
    // What makes the agent, and nothing it holds for people.
    expect(Object.keys(file).sort()).toEqual([
      "agent",
      "exportedAt",
      "format",
      "routines",
      "skills",
      "version",
    ]);
    expect(Object.keys(file.agent).sort()).toEqual([
      "description",
      "grants",
      "name",
      "slug",
      "spec",
    ]);

    const imported = await send("POST", "/api/agents/import", file);
    expect(imported.status).toBe(201);
    const result = importAgentResponseSchema.parse(await imported.json());
    expect(result).toMatchObject({
      agent: { name: "Sentinel", slug: "sentinel-2" },
      skills: 1,
      routines: 1,
    });
    expect(result.notes).toEqual([
      "The handle @sentinel is taken here, so it is @sentinel-2.",
      "The skill /release-check is /release-check-2 here.",
    ]);
    expect(result.agent.grants.map((g) => g.tool).sort()).toEqual(["recall", "remember"]);
    const skills = skillListSchema.parse(
      await json(send("GET", `/api/skills?agentId=${result.agent.id}`)),
    );
    expect(skills.items.find((s) => s.agentId === result.agent.id)).toMatchObject({
      slug: "release-check-2",
      status: "proposed",
    });
    const routines = (await json(send("GET", `/api/routines?agentId=${result.agent.id}`))) as {
      items: unknown[];
    };
    expect(routines.items.map((r) => routineSchema.parse(r))).toMatchObject([
      { name: "Release watch", status: "paused", pausedReason: "person", nextRunAt: null },
    ]);

    const bad = await send("POST", "/api/agents/import", { format: "something-else" });
    expect(bad.status).toBe(422);
  });

  it("keeps sending to an agent working (steering still works with checks around)", async () => {
    const chat = threadSchema.parse(await json(send("GET", `/api/agents/${helperId}/thread`)));
    const posted = sendMessageResponseSchema.parse(
      await json(send("POST", `/api/threads/${chat.id}/messages`, { content: "Still there?" })),
    );
    expect(posted.run?.trigger).toBe("message");
  });
});
