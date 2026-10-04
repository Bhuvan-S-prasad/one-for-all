import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { loadConfig } from "@ofa/config";
import {
  agentSchema,
  agentStatsListSchema,
  artifactListSchema,
  llmSettingsSchema,
  memoryItemSchema,
  memoryListSchema,
  realtimeMessageSchema,
  runSchema,
  sendMessageResponseSchema,
  threadSchema,
  threadSummaryPageSchema,
  usageTodaySchema,
  type CreateAgentInput,
  type MessageReceivedEvent,
  type RealtimeMessage,
  type RunCancelledEvent,
} from "@ofa/contracts";
import { asId, type AgentId, type RunId, type TenantContext } from "@ofa/core";
import { insertMemory, loadRootEnv, withDatabaseName } from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import type { RunDispatcher } from "@ofa/orchestrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// The M2 routes end to end against `oneforall_test_api_agents`: agents,
// threads and messages, runs and Stop, model settings, and the realtime
// WebSocket. Inngest is replaced by a recording dispatcher, so no agent runs
// and no model is called.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe.skipIf(!hasDb)("M2 API (integration)", async () => {
  const wsPort = await freePort();
  const base = loadConfig();
  const config = {
    ...base,
    database: {
      ...base.database,
      url: withDatabaseName(base.database.url, "oneforall_test_api_agents"),
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_agents"),
    },
    server: {
      ...base.server,
      allowedHosts: [...base.server.allowedHosts, `127.0.0.1:${wsPort}`],
    },
    // A throwaway vault key, and no environment key, so Settings is predictable.
    vault: { ...base.vault, key: randomBytes(32).toString("base64") },
    llm: { ...base.llm, apiKey: undefined },
  };

  const started: MessageReceivedEvent[] = [];
  const cancelled: RunCancelledEvent[] = [];
  const dispatcher: RunDispatcher = {
    messageReceived: async (event) => void started.push(event),
    cancelRun: async (event) => void cancelled.push(event),
  };
  const bus = createMemoryEventBus();
  const container = createContainer(config, {
    logger: createLogger({ level: "fatal", format: "json", write: () => {} }),
    bus,
    dispatcher,
  });
  const app = createApp(container);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: wsPort });
  app.injectWebSocket(server);
  afterAll(async () => {
    server.close();
    await container.close();
  });

  const origin = new URL(config.server.appUrl).origin;
  const url = (path: string) => `${origin}${path}`;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown) =>
    app.request(url(path), {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = (path: string) => app.request(url(path), { headers: { cookie } });

  const sage: CreateAgentInput = {
    name: "Sage",
    description: "Answer in one sentence.",
    spec: {
      job: "Quick answers",
      modelTier: "fast",
      voice: "brief",
      avatar: { form: "ghost", eyes: "lids", skin: "dots", color: "lilac", mark: "none" },
    },
    grants: [{ tool: "web.search", mode: "auto" }],
  };

  beforeAll(async () => {
    const res = await app.request(url("/api/setup"), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Agents HQ",
        name: "Avery Admin",
        email: "avery@example.com",
        password: "correct-horse-battery",
      }),
    });
    expect(res.status).toBe(201);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  });

  let agentId = "";
  let threadId = "";
  let runId = "";
  /** The signed-in tenant, as the orchestrator saw it on the first run. */
  const tenant = (): TenantContext => ({
    workspaceId: asId(started[0]!.workspaceId),
    userId: asId(started[0]!.userId),
  });

  it("needs a session for every M2 route", async () => {
    for (const path of ["/api/agents", "/api/runs", "/api/settings/llm"]) {
      expect((await app.request(url(path))).status).toBe(401);
    }
  });

  it("hatches an agent, with defaults filled in and the slug from its name", async () => {
    const res = await send("POST", "/api/agents", sage);
    expect(res.status).toBe(201);
    const agent = agentSchema.parse(await res.json());
    agentId = agent.id;
    expect(agent).toMatchObject({
      slug: "sage",
      status: "active",
      spec: { voice: "brief", budgets: { steps: 40 }, memoryScopes: ["agent", "workspace"] },
      grants: [{ tool: "web.search", mode: "auto" }],
    });
  });

  it("refuses a second agent with the same name, and a bad spec", async () => {
    const duplicate = await send("POST", "/api/agents", sage);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { message: "An agent called @sage already exists" },
    });
    const bad = await send("POST", "/api/agents", { ...sage, name: "Other", spec: { job: "" } });
    expect(bad.status).toBe(422);
  });

  it("lists, reads and edits agents", async () => {
    const list = await get("/api/agents");
    expect(((await list.json()) as { items: { id: string }[] }).items.map((a) => a.id)).toEqual([
      agentId,
    ]);
    const patched = await send("PATCH", `/api/agents/${agentId}`, {
      description: "Answer in one short sentence.",
      grants: [
        { tool: "web.search", mode: "auto" },
        { tool: "remember", mode: "auto" },
      ],
    });
    expect(patched.status).toBe(200);
    expect(agentSchema.parse(await patched.json()).grants).toHaveLength(2);
    expect((await get("/api/agents/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("gives one direct thread per person and agent, however often it is asked for", async () => {
    const [first, second] = await Promise.all([
      get(`/api/agents/${agentId}/thread`),
      get(`/api/agents/${agentId}/thread`),
    ]);
    const a = threadSchema.parse(await first!.json());
    const b = threadSchema.parse(await second!.json());
    expect(b.id).toBe(a.id);
    expect(a.kind).toBe("direct");
    threadId = a.id;
    const messages = await get(`/api/threads/${threadId}/messages`);
    expect(((await messages.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("saves a message with a queued run and hands the run to the orchestrator", async () => {
    const res = await send("POST", `/api/threads/${threadId}/messages`, {
      content: "What is the capital of Australia?",
    });
    expect(res.status).toBe(201);
    const { message, run } = sendMessageResponseSchema.parse(await res.json());
    expect(message).toMatchObject({ author: { type: "user" }, runId: run?.id });
    expect(run).toMatchObject({ status: "queued", trigger: "message", agentId });
    runId = run!.id;
    expect(started).toEqual([
      expect.objectContaining({ agentId, threadId, messageId: message.id, runId }),
    ]);
    expect(bus.published.map((e) => e.payload)).toContainEqual({
      kind: "message.created",
      threadId,
      messageId: message.id,
    });
  });

  it("lists runs, reads one and its events", async () => {
    const runs = (await (await get(`/api/runs?agentId=${agentId}`)).json()) as {
      items: { id: string }[];
    };
    expect(runs.items.map((r) => r.id)).toEqual([runId]);
    expect(runSchema.parse(await (await get(`/api/runs/${runId}`)).json()).status).toBe("queued");
    await container.runs.append(tenant(), asId<RunId>(runId), [
      { key: "start", type: "run.started", payload: { trigger: "message", tier: "fast" } },
    ]);
    const events = (await (await get(`/api/runs/${runId}/events`)).json()) as {
      items: { seq: number; type: string }[];
    };
    expect(events.items).toMatchObject([{ seq: 0, type: "run.started" }]);
  });

  it("shows what each run was asked, and filters by status and by what was asked", async () => {
    const one = runSchema.parse(await (await get(`/api/runs/${runId}`)).json());
    expect(one).toMatchObject({ request: "What is the capital of Australia?", reply: null });
    const ids = async (query: string) =>
      ((await (await get(`/api/runs?${query}`)).json()) as { items: { id: string }[] }).items.map(
        (r) => r.id,
      );
    expect(await ids("status=queued,running")).toEqual([runId]);
    expect(await ids("status=failed")).toEqual([]);
    expect(await ids("q=australia")).toEqual([runId]);
    expect(await ids("q=100%25")).toEqual([]); // "%" matches itself, not everything.
    expect((await get("/api/runs?status=nonsense")).status).toBe(422);
  });

  it("sends Stop for an active run", async () => {
    const res = await send("POST", `/api/runs/${runId}/stop`);
    expect(res.status).toBe(202);
    expect(cancelled).toEqual([expect.objectContaining({ runId })]);
  });

  it("refuses messages to a paused agent", async () => {
    await send("PATCH", `/api/agents/${agentId}`, { status: "paused" });
    const res = await send("POST", `/api/threads/${threadId}/messages`, { content: "Hello?" });
    expect(res.status).toBe(409);
    expect(started).toHaveLength(1);
    await send("PATCH", `/api/agents/${agentId}`, { status: "active" });
  });

  let retryRunId = "";
  it("tries a finished run again with the same message in the same chat", async () => {
    expect((await send("POST", `/api/runs/${runId}/retry`)).status).toBe(409); // Still queued.
    await container.runs.update(tenant(), asId<RunId>(runId), {
      status: "failed",
      error: { code: "model_failed", message: "The model failed" },
      endedAt: new Date(),
    });
    const res = await send("POST", `/api/runs/${runId}/retry`);
    expect(res.status).toBe(201);
    const { message, run } = sendMessageResponseSchema.parse(await res.json());
    expect(message).toMatchObject({ threadId, content: "What is the capital of Australia?" });
    expect(run).toMatchObject({ status: "queued", threadId });
    expect(run!.id).not.toBe(runId);
    expect(started.at(-1)).toMatchObject({ runId: run!.id, threadId });
    retryRunId = run!.id;
  });

  it("starts new chats, lists them most recent first, searches and archives them", async () => {
    const created = threadSchema.parse(
      await (await send("POST", `/api/agents/${agentId}/threads`)).json(),
    );
    expect(created.id).not.toBe(threadId);
    // An empty current chat is reused rather than piling up.
    const again = threadSchema.parse(
      await (await send("POST", `/api/agents/${agentId}/threads`)).json(),
    );
    expect(again.id).toBe(created.id);
    const current = threadSchema.parse(await (await get(`/api/agents/${agentId}/thread`)).json());
    expect(current.id).toBe(created.id);

    const list = async (query = "") =>
      threadSummaryPageSchema.parse(
        await (await get(`/api/agents/${agentId}/threads${query}`)).json(),
      ).items;
    expect((await list()).map((t) => [t.id, t.preview])).toEqual([
      [created.id, null],
      [threadId, "What is the capital of Australia?"],
    ]);
    expect((await list("?q=australia")).map((t) => t.id)).toEqual([threadId]);

    const archived = await send("PATCH", `/api/threads/${threadId}`, { archived: true });
    expect(threadSchema.parse(await archived.json()).archivedAt).not.toBeNull();
    expect((await list()).map((t) => t.id)).toEqual([created.id]);
    await send("PATCH", `/api/threads/${threadId}`, { archived: false });
    // Archiving and bringing back keep the order: the new chat stays current.
    expect((await list()).map((t) => t.id)).toEqual([created.id, threadId]);
    expect(threadSchema.parse(await (await get(`/api/agents/${agentId}/thread`)).json()).id).toBe(
      created.id,
    );
    expect((await send("PATCH", `/api/threads/${threadId}`, {})).status).toBe(422);
  });

  it("lists what an agent learned, confirms an unverified fact and forgets one", async () => {
    const ctx = { ...tenant(), agentId: asId<AgentId>(agentId) };
    const kept = await insertMemory(container.db, ctx, {
      scope: "agent",
      kind: "preference",
      content: "Avery prefers short answers",
      verified: true,
    });
    const doubtful = await insertMemory(container.db, ctx, {
      scope: "agent",
      kind: "fact",
      content: "Canberra has 2 million people",
      verified: false,
    });
    const items = async (query: string) =>
      memoryListSchema.parse(await (await get(`/api/memories?${query}`)).json()).items;
    expect((await items(`agentId=${agentId}`)).map((m) => m.id).sort()).toEqual(
      [kept.id, doubtful.id].sort(),
    );
    expect((await items("verified=false")).map((m) => m.id)).toEqual([doubtful.id]);

    const confirmed = await send("POST", `/api/memories/${doubtful.id}/confirm`);
    expect(memoryItemSchema.parse(await confirmed.json()).verified).toBe(true);
    expect(await items("verified=false")).toEqual([]);

    expect((await send("DELETE", `/api/memories/${kept.id}`)).status).toBe(204);
    expect((await send("DELETE", `/api/memories/${kept.id}`)).status).toBe(404);
    expect((await get("/api/memories?verified=maybe")).status).toBe(422);
  });

  it("saves logins in the vault and never sends their values back", async () => {
    const save = await send("PUT", "/api/logins", {
      site: "https://www.Example.com/login",
      username: "sam",
      password: "correct-horse-battery",
    });
    expect(save.status).toBe(201);
    const listed = await (await get("/api/logins")).text();
    expect(JSON.parse(listed).items).toEqual([
      { site: "example.com", updatedAt: expect.any(String) },
    ]);
    expect(listed).not.toContain("correct-horse-battery");
    expect(listed).not.toContain("sam");
    expect(
      (
        await send("PUT", "/api/logins", {
          site: "example.com",
          username: "sam",
          password: "short",
        })
      ).status,
    ).toBe(422);
    expect((await send("DELETE", "/api/logins/example.com")).status).toBe(204);
    expect((await send("DELETE", "/api/logins/example.com")).status).toBe(404);
  });

  it("lists a run's artifacts and serves their content only as a download", async () => {
    const runCtx = { ...tenant(), agentId: asId<AgentId>(agentId), runId: asId<RunId>(retryRunId) };
    const kept = await container.artifacts.put(runCtx, {
      key: "k1",
      kind: "file",
      name: "report <draft>.html",
      mimeType: "text/html",
      content: "<script>alert(1)</script>",
      untrusted: true,
    });
    // The same key from a retried step finds the same artifact.
    const again = await container.artifacts.put(runCtx, {
      key: "k1",
      kind: "file",
      name: "other",
      mimeType: "text/plain",
      content: "x",
      untrusted: false,
    });
    expect(again.id).toBe(kept.id);

    const list = artifactListSchema.parse(
      await (await get(`/api/runs/${retryRunId}/artifacts`)).json(),
    );
    expect(list.items).toEqual([
      expect.objectContaining({ id: kept.id, kind: "file", size: 25, untrusted: true }),
    ]);
    const content = await get(`/api/artifacts/${kept.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("application/octet-stream");
    expect(content.headers.get("content-disposition")).toBe(
      'attachment; filename="report _draft_.html"',
    );
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await content.text()).toBe("<script>alert(1)</script>");
    expect((await get("/api/artifacts/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("counts today's model requests against the daily quota, and runs per agent", async () => {
    // A finished run's log is closed, so the call is logged on the open retry.
    await container.runs.append(tenant(), asId<RunId>(retryRunId), [
      {
        key: "model-1",
        type: "model.called",
        payload: {
          provider: "openrouter",
          model: "meta-llama/llama-3.3-70b-instruct:free",
          tier: "fast",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0,
          durationMs: 100,
          finishReason: "stop",
          toolCalls: 0,
        },
      },
    ]);
    const usage = usageTodaySchema.parse(await (await get("/api/settings/usage")).json());
    expect(usage).toMatchObject({ requests: 1, dailyLimit: 1000, perMinute: 20 });
    expect(Date.parse(usage.resetsAt) - Date.parse(usage.since)).toBe(86_400_000);

    const stats = agentStatsListSchema.parse(await (await get("/api/agents/stats")).json());
    expect(stats.items).toEqual([
      expect.objectContaining({ agentId, runsThisWeek: 2, lastResult: null }),
    ]);
  });

  it("stores the model key encrypted and only ever shows its last four characters", async () => {
    const before = llmSettingsSchema.parse(await (await get("/api/settings/llm")).json());
    expect(before).toMatchObject({
      provider: { id: "openrouter", requiresApiKey: true },
      key: { configured: false, source: null, hint: null },
    });
    expect(before.tiers.standard.length).toBeGreaterThan(0);

    const key = "sk-or-test-0000111122223333";
    const put = await send("PUT", "/api/settings/llm/key", { apiKey: key });
    expect(put.status).toBe(200);
    const putBody = await put.text();
    const readBody = await (await get("/api/settings/llm")).text();
    for (const body of [putBody, readBody]) {
      expect(body).not.toContain(key);
      expect(llmSettingsSchema.parse(JSON.parse(body)).key).toEqual({
        configured: true,
        source: "workspace",
        hint: "…3333",
      });
    }

    const removed = await send("DELETE", "/api/settings/llm/key");
    expect(removed.status).toBe(200);
    expect(llmSettingsSchema.parse(await removed.json()).key.configured).toBe(false);
  });

  describe("realtime WebSocket", () => {
    const wsUrl = `ws://127.0.0.1:${wsPort}/api/ws`;

    /** Open a socket and collect what arrives until `until` matches. */
    function listen(headers: Record<string, string>) {
      const ws = new WebSocket(wsUrl, { headers } as never);
      const received: RealtimeMessage[] = [];
      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("socket refused")), { once: true });
      });
      ws.addEventListener("message", (event) => {
        received.push(realtimeMessageSchema.parse(JSON.parse(String(event.data))));
      });
      const waitFor = async (match: (m: RealtimeMessage) => boolean) => {
        for (let i = 0; i < 100; i += 1) {
          const hit = received.find(match);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error(`timed out; got ${received.map((m) => m.type).join(", ")}`);
      };
      return { ws, opened, waitFor };
    }

    it("refuses a socket without a session or from another origin", async () => {
      await expect(listen({ origin }).opened).rejects.toThrow("socket refused");
      await expect(listen({ cookie, origin: "https://evil.example" }).opened).rejects.toThrow(
        "socket refused",
      );
    });

    it("streams new messages, run updates and run events to a signed-in socket", async () => {
      const socket = listen({ cookie, origin });
      await socket.opened;
      await socket.waitFor((m) => m.type === "ready");

      const res = await send("POST", `/api/threads/${threadId}/messages`, { content: "Again?" });
      const { message, run } = sendMessageResponseSchema.parse(await res.json());
      const live = await socket.waitFor(
        (m) => m.type === "message.created" && m.message.id === message.id,
      );
      expect(live).toMatchObject({ message: { content: "Again?" } });
      await container.runs.update(tenant(), asId<RunId>(run!.id), { status: "running" });
      await container.runs.append(tenant(), asId<RunId>(run!.id), [
        { key: "start", type: "run.started", payload: { trigger: "message", tier: "fast" } },
      ]);
      await socket.waitFor(
        (m) => m.type === "run.updated" && m.run.id === run!.id && m.run.status === "running",
      );
      await socket.waitFor((m) => m.type === "run.event" && m.event.runId === run!.id);
      socket.ws.close();
    });
  });
});
