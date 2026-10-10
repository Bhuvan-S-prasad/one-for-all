import {
  asId,
  type AgentGrantRule,
  type AgentProfile,
  type RunContext,
  type ToolCallStore,
} from "@ofa/core";
import { createPolicyEngine } from "@ofa/policy";
import {
  createToolExecutor,
  createToolRegistry,
  loadToolkitTool,
  type ToolDefinition,
} from "@ofa/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  annotationsFor,
  CATALOG,
  createMcpConnections,
  createMcpToolkits,
  createMemoryConnectionStore,
  startFakeMcpServer,
  testCipher,
  toolNameFor,
  type FakeMcpServer,
} from "./index";

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("alice"),
  agentId: asId("agent"),
  runId: asId("run"),
};
const REDIRECT = "http://localhost:3000/api/connections/callback";

describe("naming and hints", () => {
  it("puts a server's tools in our app.action form", () => {
    expect(toolNameFor("notion", "notion-search")).toBe("notion.search");
    expect(toolNameFor("notion", "notion-query-data-sources")).toBe("notion.query_data_sources");
    expect(toolNameFor("gmail", "create_draft")).toBe("gmail.create_draft");
    expect(toolNameFor("linear", "Get Issue")).toBe("linear.get_issue");
    expect(toolNameFor("x", "2fa-reset")).toBe("x.t_2fa_reset");
    expect(toolNameFor("x", "---")).toBeNull();
  });

  it("reads MCP hints the safe way: not read-only means outbound, and destructive unless it says not", () => {
    const info = (annotations: object) => ({
      name: "t",
      description: "",
      inputSchema: {},
      annotations,
    });
    expect(annotationsFor(info({ readOnlyHint: true }))).toEqual({
      readOnly: true,
      destructive: false,
      idempotent: false,
      outbound: false,
    });
    expect(annotationsFor(info({}))).toMatchObject({ destructive: true, outbound: true });
    expect(annotationsFor(info({ destructiveHint: false }))).toMatchObject({
      destructive: false,
      outbound: true,
    });
  });
});

/** Tool calls in memory, as the executor records them. */
function memoryCalls(): ToolCallStore {
  const rows = new Map<
    string,
    { status: "in_flight" | "done" | "failed"; result: unknown; untrusted: boolean }
  >();
  return {
    async begin(_ctx, input) {
      const existing = rows.get(input.idempotencyKey);
      if (existing) return { created: false, existing };
      rows.set(input.idempotencyKey, { status: "in_flight", result: null, untrusted: false });
      return { created: true };
    },
    async complete(_ctx, key, outcome) {
      rows.set(key, { status: "done", result: outcome.result, untrusted: outcome.untrusted });
    },
    async fail(_ctx, key) {
      rows.set(key, { status: "failed", result: null, untrusted: false });
    },
  };
}

describe("connected apps as toolkits", () => {
  let fake: FakeMcpServer;
  beforeEach(async () => {
    fake = await startFakeMcpServer();
  });
  afterEach(() => fake.close());

  /** A workspace with one app installed from a test catalog, signed in to as Alice. */
  async function setup(entryId: string, grants: AgentGrantRule[], directToolkitLimit = 8) {
    const store = createMemoryConnectionStore();
    const entry = {
      ...CATALOG[0]!,
      id: entryId,
      name: entryId === "gmail" ? "Gmail" : "Team Notes",
      url: fake.mcpUrl,
      authOrigin: fake.url,
      apiOrigins: [fake.url],
    };
    const mcp = createMcpConnections({
      store,
      cipher: testCipher,
      redirectUrl: REDIRECT,
      catalog: [entry],
    });
    const server = await mcp.install(ctx, entryId);
    const start = await mcp.startSignIn(ctx, server.id);
    if (start.status !== "redirect") throw new Error("expected a sign-in address");
    const back = new URL(
      (await fetch(start.authorizationUrl, { redirect: "manual" })).headers.get("location") ?? "",
    );
    await mcp.finishSignIn(ctx, {
      code: back.searchParams.get("code") ?? "",
      state: back.searchParams.get("state") ?? "",
      issuer: back.searchParams.get("iss") ?? "",
    });
    const toolkits = createMcpToolkits({ connections: store, mcp, catalog: [entry] });
    expect(await toolkits.refresh(ctx, server.id)).toBe(2);
    const agent = { id: ctx.agentId, grants, memoryScopes: [] } as unknown as AgentProfile;
    const agents = { get: async () => agent };
    const executor = createToolExecutor({
      registry: createToolRegistry([loadToolkitTool()] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
      toolkits,
      directToolkitLimit,
    });
    return { store, mcp, server, toolkits, executor };
  }

  const call = (name: string, args: unknown, step: string, extra = {}) => ({
    name,
    args,
    toolCallId: step,
    idempotencyKey: `run:${step}`,
    tainted: false,
    ...extra,
  });

  it("lists small apps directly and runs their tools as the person, as outside content", async () => {
    const { executor } = await setup("notes", [{ tool: "notes.*", mode: "auto" }]);
    const names = (await executor.listTools(ctx)).map((t) => t.name);
    // Two tools: no need to load anything, so load_toolkit stays out of the way.
    expect(names).toEqual(["notes.search", "notes.delete_page"]);

    const found = await executor.execute(call("notes.search", { query: "roadmap" }, "t1"), ctx);
    expect(found).toMatchObject({
      status: "ok",
      content: 'Found 2 pages for "roadmap".',
      untrusted: true,
      verdict: "auto",
    });
    // The server's own schema is checked first.
    expect(await executor.execute(call("notes.search", {}, "t2"), ctx)).toMatchObject({
      status: "error",
      code: "invalid_args",
    });
    // Granted as part of notes.*, a destructive tool asks first (and deleting is always-human).
    const deleting = await executor.execute(call("notes.delete_page", { id: "p1" }, "t3"), ctx);
    expect(deleting).toMatchObject({ status: "blocked", verdict: "human" });
    // The card names the app and action, and lists the arguments (nothing here to edit).
    expect(deleting).toMatchObject({ summary: "Use Team Notes: Delete page", showArgs: true });
    expect(deleting).not.toHaveProperty("editable");
    expect(fake.counts.calls).toBe(1);
  });

  it("lists one app's tools as agents see them, for choosing grants", async () => {
    const { toolkits, server } = await setup("notes", []);
    const kit = await toolkits.forServer(ctx, server.id);
    expect(
      kit?.tools.map((t) => [t.name, t.annotations.readOnly, t.annotations.destructive]),
    ).toEqual([
      ["notes.search", true, false],
      ["notes.delete_page", false, true],
    ]);
    expect(await toolkits.forServer(ctx, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("keeps a large app behind load_toolkit until the run loads it", async () => {
    const { executor } = await setup("notes", [{ tool: "notes.*", mode: "auto" }], 1);
    const before = await executor.listTools(ctx);
    expect(before.map((t) => t.name)).toEqual(["load_toolkit"]);
    // Its tools by name, so a large app can be picked from in one call.
    expect(before[0]?.description).toContain("notes (Team Notes, 2 tools: search, delete_page)");

    const loaded = await executor.execute(call("load_toolkit", { app: "notes" }, "t1"), ctx);
    expect(loaded).toMatchObject({ status: "ok", verdict: "auto" });
    expect(loaded.status === "ok" && loaded.content).toContain("- notes.search:");
    expect(await executor.execute(call("load_toolkit", { app: "nope" }, "t2"), ctx)).toMatchObject({
      status: "error",
      message: "There is no app called nope. You can load: notes.",
    });

    const after = await executor.listTools(ctx, { toolkits: ["notes"] });
    expect(after.map((t) => t.name)).toEqual(["notes.search", "notes.delete_page"]);
  });

  it("loads only the tools picked from an app, leaving the rest to load later", async () => {
    const { executor } = await setup("notes", [{ tool: "notes.*", mode: "auto" }], 1);
    const picked = await executor.execute(
      call("load_toolkit", { app: "notes", tools: ["notes_search"] }, "t1"),
      ctx,
    );
    expect(picked).toMatchObject({ status: "ok" });
    expect(picked.status === "ok" && picked.content).toContain("Loaded from Team Notes");
    expect(picked.status === "ok" && picked.content).not.toContain("delete_page");
    expect(
      await executor.execute(call("load_toolkit", { app: "notes", tools: ["rename"] }, "t2"), ctx),
    ).toMatchObject({
      status: "error",
      code: "unknown_tool",
      message: "Team Notes has no notes.rename. Its tools: notes.search, notes.delete_page.",
    });
    // Still waiting, so more can be loaded; only the picked tool is listed.
    const after = await executor.listTools(ctx, { toolkits: ["notes.search"] });
    expect(after.map((t) => t.name)).toEqual(["load_toolkit", "notes.search"]);
  });

  it("shows nothing of an app the agent wasn't granted", async () => {
    const { executor } = await setup("notes", [{ tool: "web.search", mode: "auto" }]);
    expect((await executor.listTools(ctx)).map((t) => t.name)).toEqual([]);
    expect(await executor.execute(call("notes.search", { query: "x" }, "t1"), ctx)).toMatchObject({
      status: "blocked",
      verdict: "deny",
    });
  });

  it("gmail.send_draft says what goes out, asks first, then sends that draft once", async () => {
    const { executor, mcp, server } = await setup("gmail", [{ tool: "gmail.*", mode: "auto" }]);
    fake.addDraft("d1", {
      to: "sam@example.com",
      subject: "Quarterly numbers",
      body: "Hi Sam, attached.",
    });
    expect((await executor.listTools(ctx)).map((t) => t.name)).toContain("gmail.send_draft");

    const held = await executor.execute(call("gmail.send_draft", { draft_id: "d1" }, "t1"), ctx);
    expect(held).toMatchObject({
      status: "blocked",
      verdict: "approve",
      summary: "Send the email “Quarterly numbers” to sam@example.com\nHi Sam, attached.",
    });
    expect(fake.sentDrafts).toEqual([]);

    const sent = await executor.execute(
      call("gmail.send_draft", { draft_id: "d1" }, "t1", { approved: true }),
      ctx,
    );
    expect(sent).toMatchObject({
      status: "ok",
      content: "Sent. Gmail message msg_d1 in thread thread_d1.",
    });
    expect(fake.sentDrafts).toEqual(["d1"]);

    // An expired token is refreshed before sending; a bad draft ID never reaches Gmail.
    fake.expireAccessTokens();
    fake.addDraft("d2", { to: "a@example.com", subject: "Two", body: "" });
    expect(
      await executor.execute(
        call("gmail.send_draft", { draft_id: "d2" }, "t2", { approved: true }),
        ctx,
      ),
    ).toMatchObject({ status: "ok" });
    expect(
      await executor.execute(call("gmail.send_draft", { draft_id: "../x" }, "t3"), ctx),
    ).toMatchObject({ status: "error", code: "invalid_args" });

    // The sign-in goes only to the origins the entry lists.
    await expect(mcp.fetchAs(ctx, server.id, "https://evil.example/collect")).rejects.toMatchObject(
      {
        reason: "unavailable",
      },
    );
  });
});
