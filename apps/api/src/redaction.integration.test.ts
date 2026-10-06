import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig } from "@ofa/config";
import { sendMessageResponseSchema, threadSchema, type MessageReceivedEvent } from "@ofa/contracts";
import { asId, type AgentId, type RunContext, type RunId, type ThreadId } from "@ofa/core";
import { createDatabase, loadRootEnv, schema, withDatabaseName, withTenant } from "@ofa/db";
import { createMemoryEventBus } from "@ofa/events";
import { createMemoStepRunner, createScriptedLLM, runAgent } from "@ofa/harness";
import type { RunDispatcher } from "@ofa/orchestrator";
import { defineTool } from "@ofa/tools";
import { createVault, REDACTED } from "@ofa/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app";
import { createContainer } from "./container";

// M4.11: known secrets never reach logs, traces, the run log, approvals,
// replies or the model, through the real container: vault, tool executor,
// harness, logger and telemetry as the server wires them. The model is
// scripted, and its test tools leak secrets on purpose. Against
// `oneforall_test_api_redaction`.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

// Throwaway values for this run only.
const API_KEY = `sk-test-${randomBytes(12).toString("hex")}`;
const TOKEN = `ya29.${randomBytes(18).toString("base64url")}`;
const SECRETS = [API_KEY, TOKEN];

interface CapturedSpan {
  name: string;
  attributes: unknown;
  events: { name: string; attributes: unknown }[];
}

describe.skipIf(!hasDb)("secret redaction (integration)", async () => {
  const base = loadConfig();
  const dbUrl = withDatabaseName(base.database.url, "oneforall_test_api_redaction");
  const config = {
    ...base,
    database: {
      ...base.database,
      url: dbUrl,
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_redaction"),
    },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
    llm: { ...base.llm, apiKey: undefined },
    // Telemetry on, so spans are made; the exporter below captures them.
    telemetry: { ...base.telemetry, otlpEndpoint: undefined },
  };

  const lines: string[] = [];
  const spans: CapturedSpan[] = [];
  const exporter = {
    export(batch: readonly unknown[], done: (result: { code: number }) => void) {
      for (const span of batch as {
        name: string;
        attributes: unknown;
        events: { name: string; attributes?: unknown }[];
      }[]) {
        spans.push({
          name: span.name,
          attributes: span.attributes,
          events: span.events.map((e) => ({ name: e.name, attributes: e.attributes })),
        });
      }
      done({ code: 0 });
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };

  const tools = [
    defineTool({
      name: "test.echo",
      description: "Returns text that contains the workspace's secrets.",
      input: z.object({ note: z.string() }),
      annotations: { readOnly: true },
      async run() {
        return {
          content: `key=${API_KEY} json=${JSON.stringify({ token: TOKEN })} url=?k=${encodeURIComponent(API_KEY)}`,
          untrusted: true,
        };
      },
    }),
    defineTool({
      name: "test.fail",
      description: "Fails with a secret in the error.",
      input: z.object({}),
      annotations: { readOnly: true },
      async run() {
        throw new Error(`upstream rejected token ${TOKEN}`);
      },
    }),
    defineTool({
      name: "test.send",
      description: "Sends a message.",
      input: z.object({ to: z.string(), body: z.string() }),
      annotations: { outbound: true },
      async run() {
        return { content: "sent", untrusted: false };
      },
      async describe(args) {
        return `Send "${args.body}" to ${args.to}`;
      },
    }),
  ];
  const llm = createScriptedLLM([
    { toolCalls: [{ name: "test.echo", args: { note: "look" } }] },
    { toolCalls: [{ name: "test.fail", args: {} }] },
    // Outbound in a tainted run: held for a person.
    { toolCalls: [{ name: "test.send", args: { to: "ops@example.com", body: `key ${API_KEY}` } }] },
    // The model repeating a secret in arguments and in its answer.
    { toolCalls: [{ name: "test.echo", args: { note: `remember ${API_KEY}` } }] },
    { text: `Done. The key was ${API_KEY} and the token ${TOKEN}.` },
  ]);

  const started: MessageReceivedEvent[] = [];
  const dispatcher: RunDispatcher = {
    messageReceived: async (event) => void started.push(event),
    cancelRun: async () => {},
    approvalDecided: async () => {},
  };
  const container = createContainer(config, {
    logWrite: (line) => void lines.push(line),
    telemetryExporter: exporter as never,
    llm,
    extraTools: tools as never,
    bus: createMemoryEventBus(),
    dispatcher,
  });
  const app = createApp(container);
  // A second connection, as another process would store the secrets: the
  // container's vault learns them only from the database.
  const other = createDatabase(dbUrl, { max: 1 });
  let closed = false;
  afterAll(async () => {
    if (!closed) await container.close();
    await other.close();
  });

  const origin = new URL(config.server.appUrl).origin;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  let ctx: RunContext;
  let threadId = "";

  beforeAll(async () => {
    const setup = await app.request(`${origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Redaction HQ",
        name: "Riley Owner",
        email: "riley@example.com",
        password: "correct-horse-battery",
      }),
    });
    expect(setup.status).toBe(201);
    cookie = setup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const created = await send("POST", "/api/agents", {
      name: "Leaky",
      description: "Testing redaction.",
      spec: {
        job: "Tests",
        modelTier: "fast",
        voice: "brief",
        avatar: { form: "ghost", eyes: "lids", skin: "dots", color: "lilac", mark: "none" },
      },
      grants: tools.map((t) => ({ tool: t.name, mode: "auto" })),
    });
    expect(created.status).toBe(201);
    const agentId = ((await created.json()) as { id: string }).id;
    const thread = threadSchema.parse(
      await (await send("GET", `/api/agents/${agentId}/thread`)).json(),
    );
    threadId = thread.id;
    const posted = await send("POST", `/api/threads/${threadId}/messages`, { content: "Go." });
    const { run } = sendMessageResponseSchema.parse(await posted.json());
    const event = started[0]!;
    ctx = {
      workspaceId: asId(event.workspaceId),
      userId: asId(event.userId),
      agentId: asId<AgentId>(agentId),
      runId: asId<RunId>(run!.id),
    };

    // The workspace's secrets: an API key, and a connection's tokens.
    const vault = createVault({ db: other.db, key: config.vault.key });
    await vault.put(ctx, "integration.test.api_key", API_KEY);
    const serverId = randomUUID();
    const connectionId = randomUUID();
    await withTenant(other.db, ctx, (tx) =>
      tx.insert(schema.mcpServer).values({
        id: serverId,
        workspaceId: ctx.workspaceId,
        slug: "gmail",
        name: "Gmail",
        url: "https://mcp.gmail.example/mcp",
      }),
    );
    const tokens = vault.seal(
      ctx,
      { table: "connection", id: connectionId },
      JSON.stringify({
        access_token: TOKEN,
        refresh_token: `1//${randomBytes(16).toString("hex")}`,
      }),
    );
    await withTenant(other.db, ctx, (tx) =>
      tx.insert(schema.connection).values({
        id: connectionId,
        workspaceId: ctx.workspaceId,
        mcpServerId: serverId,
        userId: ctx.userId,
        status: "active",
        credentialsCiphertext: tokens.valueCiphertext,
        keyCiphertext: tokens.keyCiphertext,
        keyId: tokens.keyId,
      }),
    );

    const result = await runAgent(
      { ctx, threadId: asId<ThreadId>(threadId), trigger: "message" },
      container.harness,
      // Nobody answers the approval: it expires.
      createMemoStepRunner({ onWait: () => null }),
    );
    expect(result.status).toBe("succeeded");
  });

  const leaks = (value: unknown) => {
    const text = JSON.stringify(value);
    return SECRETS.filter(
      (secret) => text.includes(secret) || text.includes(encodeURIComponent(secret)),
    );
  };

  it("tool output reaches the model redacted", () => {
    const toolMessages = llm.requests.flatMap((r) => r.messages.filter((m) => m.role === "tool"));
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);
    expect(leaks(toolMessages)).toEqual([]);
    expect(JSON.stringify(toolMessages)).toContain(REDACTED);
  });

  it("the run log, tool calls, approval and reply hold no secret", async () => {
    const [events, calls, approvals, messages] = await withTenant(other.db, ctx, async (tx) => [
      await tx.select().from(schema.runEvent),
      await tx.select().from(schema.toolCall),
      await tx.select().from(schema.approval),
      await tx.select().from(schema.message),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["tool.called", "tool.failed", "message.created"]),
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ tool: "test.send", status: "expired" });
    const reply = messages.find((m) => m.authorType === "agent");
    expect(reply?.content).toBe(`Done. The key was ${REDACTED} and the token ${REDACTED}.`);
    expect(leaks({ events, calls, approvals, messages })).toEqual([]);
  });

  it("logs hold no secret, the server's own included", () => {
    container.logger.error("upstream failed", {
      error: new Error(`token ${TOKEN}`),
      detail: `key=${API_KEY}`,
      config: config.auth.secret,
    });
    const line = lines.at(-1) ?? "";
    expect(line).toContain("upstream failed");
    expect(leaks(lines)).toEqual([]);
    expect(line).not.toContain(config.auth.secret);
  });

  it("traces hold no secret, recorded errors included", async () => {
    await container.close(); // flushes spans to the exporter
    closed = true;
    const failed = spans.find(
      (s) => s.name === "tool.call" && s.events.some((e) => e.name === "exception"),
    );
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed)).toContain(`upstream rejected token ${REDACTED}`);
    expect(leaks(spans)).toEqual([]);
  });
});
