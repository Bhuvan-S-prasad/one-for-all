import { randomBytes } from "node:crypto";
import { loadConfig } from "@ofa/config";
import {
  catalogListSchema,
  sendMessageResponseSchema,
  threadSchema,
  type MessageReceivedEvent,
  mcpServerListSchema,
  mcpServerSchema,
  mcpToolListSchema,
  signInStartSchema,
} from "@ofa/contracts";
import { createDatabase, loadRootEnv, schema, withDatabaseName, withTenant } from "@ofa/db";
import { asId, type RunContext, type ThreadId } from "@ofa/core";
import { createMemoryEventBus } from "@ofa/events";
import { createMemoStepRunner, createScriptedLLM, runAgent } from "@ofa/harness";
import type { RunDispatcher } from "@ofa/orchestrator";
import { startFakeMcpServer, type FakeMcpServer } from "@ofa/mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer } from "./container";
import { createLogger } from "./lib/logger";

// M4.03 end to end against `oneforall_test_api_mcp`: add a custom MCP server,
// sign in through its OAuth (a fake server on 127.0.0.1 that agrees at once),
// come back through the callback, list its tools, sign out, remove it.
loadRootEnv();
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("MCP connections API (integration)", async () => {
  const base = loadConfig();
  const dbUrl = withDatabaseName(base.database.url, "oneforall_test_api_mcp");
  const config = {
    ...base,
    database: {
      ...base.database,
      url: dbUrl,
      migrationUrl: withDatabaseName(base.database.migrationUrl, "oneforall_test_api_mcp"),
    },
    vault: { ...base.vault, source: "env" as const, key: randomBytes(32).toString("base64") },
  };
  // The agent run in this file: search the app, then answer.
  const llm = createScriptedLLM([
    { toolCalls: [{ name: "team_notes.search", args: { query: "roadmap" } }] },
    { text: "The roadmap has 2 pages." },
  ]);
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
  const db = createDatabase(dbUrl, { max: 1 });
  let fake: FakeMcpServer;
  afterAll(async () => {
    await fake?.close();
    await container.close();
    await db.close();
  });

  const origin = new URL(config.server.appUrl).origin;
  let cookie = "";
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    fake = await startFakeMcpServer();
    const res = await app.request(`${origin}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        workspaceName: "Connected HQ",
        name: "Morgan Owner",
        email: "morgan@example.com",
        password: "correct-horse-battery",
      }),
    });
    expect(res.status).toBe(201);
    cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  });

  let serverId = "";

  it("adds a custom server only with an explicit yes, and a safe address", async () => {
    const input = { name: "Team Notes", url: fake.mcpUrl };
    expect((await send("POST", "/api/mcp-servers", input)).status).toBe(422);
    const http = { ...input, url: "http://notes.example/mcp", acknowledgeRisk: true };
    expect((await send("POST", "/api/mcp-servers", http)).status).toBe(422);
    const res = await send("POST", "/api/mcp-servers", { ...input, acknowledgeRisk: true });
    expect(res.status).toBe(201);
    const server = mcpServerSchema.parse(await res.json());
    expect(server).toMatchObject({ slug: "team_notes", catalogId: null, connection: null });
    serverId = server.id;
    const again = await send("POST", "/api/mcp-servers", { ...input, acknowledgeRisk: true });
    expect(again.status).toBe(409);
  });

  it("signs in through the provider and comes back to the Connections page", async () => {
    const start = signInStartSchema.parse(
      await (await send("POST", `/api/mcp-servers/${serverId}/connect`)).json(),
    );
    if (start.status !== "redirect") throw new Error("expected a sign-in address");
    expect(start.authorizationUrl.startsWith(`${fake.url}/authorize?`)).toBe(true);

    // The browser: the provider agrees and sends it to our callback.
    const consent = await fetch(start.authorizationUrl, { redirect: "manual" });
    const callback = new URL(consent.headers.get("location") ?? "");
    expect(callback.origin + callback.pathname).toBe(`${origin}/api/connections/callback`);
    const back = await app.request(callback.href, { headers: { cookie } });
    expect(back.status).toBe(302);
    const page = new URL(back.headers.get("location") ?? "");
    expect(page.origin).toBe(config.server.webUrl);
    expect(page.pathname).toBe("/connections");
    expect(page.searchParams.get("connected")).toBe("team_notes");

    const list = mcpServerListSchema.parse(await (await send("GET", "/api/mcp-servers")).json());
    expect(list.items[0]).toMatchObject({
      authOrigin: fake.url,
      // The callback kept its tool list for agents.
      toolCount: 2,
      connection: { status: "active", lastError: null },
    });
    // Stored sealed; the list never carries a token.
    const [row] = await withTenant(db.db, await tenantOf(), (tx) =>
      tx.select().from(schema.connection),
    );
    expect(row?.credentialsCiphertext?.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain("access_token");
    expect(JSON.stringify(list)).not.toMatch(/token":/);
  });

  it("lists the server's tools as the person", async () => {
    const tools = mcpToolListSchema.parse(
      await (await send("GET", `/api/mcp-servers/${serverId}/tools`)).json(),
    );
    expect(tools.items.map((t) => t.name)).toEqual(["search", "delete_page"]);
    expect(tools.items[1]?.annotations).toEqual({ destructiveHint: true });
    // As agents see them, from the list kept at sign-in: for choosing grants.
    const kept = await (await send("GET", `/api/mcp-servers/${serverId}/agent-tools`)).json();
    expect(kept).toEqual({
      items: [
        expect.objectContaining({ name: "team_notes.search", readOnly: true, destructive: false }),
        expect.objectContaining({
          name: "team_notes.delete_page",
          readOnly: false,
          destructive: true,
        }),
      ],
    });
  });

  it("an agent granted the app uses its tools in a run, with the person's sign-in", async () => {
    const refreshed = await send("POST", `/api/mcp-servers/${serverId}/tools/refresh`);
    expect(await refreshed.json()).toEqual({ count: 2 });
    const created = await send("POST", "/api/agents", {
      name: "Notetaker",
      description: "Finds things in the team's notes.",
      spec: {
        job: "Notes",
        modelTier: "fast",
        voice: "brief",
        avatar: { form: "ghost", eyes: "lids", skin: "dots", color: "lilac", mark: "none" },
      },
      grants: [{ tool: "team_notes.*", mode: "auto" }],
    });
    expect(created.status).toBe(201);
    const agentId = ((await created.json()) as { id: string }).id;
    const thread = threadSchema.parse(
      await (await send("GET", `/api/agents/${agentId}/thread`)).json(),
    );
    const posted = await send("POST", `/api/threads/${thread.id}/messages`, {
      content: "What's on the roadmap?",
    });
    const { run } = sendMessageResponseSchema.parse(await posted.json());
    const event = started.at(-1)!;
    const ctx: RunContext = {
      workspaceId: asId(event.workspaceId),
      userId: asId(event.userId),
      agentId: asId(agentId),
      runId: asId(run!.id),
    };
    const result = await runAgent(
      { ctx, threadId: asId<ThreadId>(thread.id), trigger: "message" },
      container.harness,
      createMemoStepRunner(),
    );
    expect(result).toMatchObject({ status: "succeeded", stopReason: "final_answer" });
    // The model was offered the app's tools (two: small enough to list directly).
    expect((llm.requests[0]?.tools ?? []).map((t) => t.name)).toEqual(
      expect.arrayContaining(["team_notes.search", "team_notes.delete_page"]),
    );
    const events = await withTenant(db.db, ctx, (tx) => tx.select().from(schema.runEvent));
    const done = events.find((e) => e.runId === run!.id && e.type === "tool.completed");
    expect(done?.payload).toMatchObject({ tool: "team_notes.search", untrusted: true });
    expect(JSON.stringify(done?.payload)).toContain("Found 2 pages");
    expect(events.some((e) => e.runId === run!.id && e.type === "run.tainted")).toBe(true);
  });

  it("sends a cancelled or unknown sign-in back with a plain message", async () => {
    const cancelled = await app.request(`${origin}/api/connections/callback?error=access_denied`, {
      headers: { cookie },
    });
    expect(new URL(cancelled.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "Sign-in was cancelled.",
    );
    const unknown = await app.request(`${origin}/api/connections/callback?code=x&state=made-up`, {
      headers: { cookie },
    });
    expect(new URL(unknown.headers.get("location") ?? "").searchParams.get("error")).toMatch(
      /doesn't match one in progress/,
    );
  });

  it("signs out, after which tools need a sign-in again; then removes the server", async () => {
    expect((await send("DELETE", `/api/mcp-servers/${serverId}/connection`)).status).toBe(204);
    const tools = await send("GET", `/api/mcp-servers/${serverId}/tools`);
    expect(tools.status).toBe(400);
    expect(((await tools.json()) as { error: { message: string } }).error.message).toBe(
      "Sign in to Team Notes first.",
    );
    expect((await send("DELETE", `/api/mcp-servers/${serverId}`)).status).toBe(204);
    const actions = (
      await withTenant(db.db, await tenantOf(), (tx) => tx.select().from(schema.auditLog))
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "mcp_server.added",
        "connection.created",
        "connection.removed",
        "mcp_server.removed",
      ]),
    );
  });

  it("lists the catalog and installs entries pinned to their sign-in sites", async () => {
    const catalog = catalogListSchema.parse(
      await (await send("GET", "/api/mcp-servers/catalog")).json(),
    );
    expect(catalog.items.map((i) => i.id)).toContain("notion");
    expect(catalog.redirectUrl).toBe(`${origin}/api/connections/callback`);
    expect(catalog.items.find((i) => i.id === "gmail")).toMatchObject({
      setup: "own_client",
      guide: "docs/guides/google-oauth-client.md",
      serverId: null,
    });

    // Installing contacts nothing: the address and sign-in site come from the catalog.
    const notion = await send("POST", "/api/mcp-servers/catalog/notion", {});
    expect(notion.status).toBe(201);
    expect(mcpServerSchema.parse(await notion.json())).toMatchObject({
      slug: "notion",
      catalogId: "notion",
      url: "https://mcp.notion.com/mcp",
      authOrigin: "https://mcp.notion.com",
    });
    expect((await send("POST", "/api/mcp-servers/catalog/notion", {})).status).toBe(409);
    expect((await send("POST", "/api/mcp-servers/catalog/nope", {})).status).toBe(404);

    // GitHub can't register us itself: it needs the self-hoster's OAuth app.
    expect((await send("POST", "/api/mcp-servers/catalog/github", {})).status).toBe(422);
    const github = await send("POST", "/api/mcp-servers/catalog/github", {
      client: { clientId: "Iv1.0123456789", clientSecret: "github-secret-0123456789" },
    });
    expect(github.status).toBe(201);
    const githubId = mcpServerSchema.parse(await github.json()).id;
    const replaced = await send("PUT", `/api/mcp-servers/${githubId}/client`, {
      clientId: "Iv1.9876543210",
      clientSecret: "github-secret-9876543210",
    });
    expect(replaced.status).toBe(204);
    const listed = catalogListSchema.parse(
      await (await send("GET", "/api/mcp-servers/catalog")).json(),
    );
    expect(listed.items.find((i) => i.id === "github")?.serverId).toBe(githubId);
    // The secret is sealed, and the audit log keeps only the public client ID.
    const audit = await withTenant(db.db, await tenantOf(), (tx) =>
      tx.select().from(schema.auditLog),
    );
    expect(JSON.stringify(audit)).not.toContain("github-secret");
    const [server] = (
      await withTenant(db.db, await tenantOf(), (tx) => tx.select().from(schema.mcpServer))
    ).filter((s) => s.id === githubId);
    expect(server?.clientCiphertext?.startsWith("v1.")).toBe(true);
  });

  /** The signed-in tenant, from the session. */
  async function tenantOf() {
    const me = (await (await send("GET", "/api/session")).json()) as {
      user: { id: string };
      workspace: { id: string };
    };
    return { workspaceId: me.workspace.id, userId: me.user.id } as never;
  }
});
