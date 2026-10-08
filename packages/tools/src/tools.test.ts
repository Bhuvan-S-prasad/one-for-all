import {
  asId,
  type AgentProfile,
  type MemoryRecord,
  type MemoryStore,
  type PolicyEngine,
  type RunContext,
  type ToolCallRecord,
  type ToolCallStore,
} from "@ofa/core";
import { createPolicyEngine } from "@ofa/policy";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  builtinTools,
  createSearxngProvider,
  createToolExecutor,
  createToolRegistry,
  defineJsonSchemaTool,
  defineTool,
  editableTextFields,
  htmlToText,
  isPrivateAddress,
  READ_CHUNK_CHARS,
  safeFetch,
  toDescriptor,
  ToolSchemaError,
  type ToolDefinition,
} from "./index";

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("a"),
  runId: asId("r"),
};

function agentWith(grants: AgentProfile["grants"]): AgentProfile {
  return {
    id: ctx.agentId,
    slug: "a",
    name: "A",
    description: "",
    status: "active",
    job: "x",
    modelTier: "fast",
    autonomy: "act-with-approval",
    voice: "calm",
    memoryScopes: ["agent"],
    budgets: { steps: 5, tokens: 10_000 },
    grants,
  };
}

function memoryCalls(): ToolCallStore & { rows: Map<string, ToolCallRecord> } {
  const rows = new Map<string, ToolCallRecord>();
  return {
    rows,
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

let sent = 0;
let siteAsked = 0;
const echo = defineTool({
  name: "test.echo",
  description: "Echo",
  input: z.object({ text: z.string().min(1) }),
  annotations: { readOnly: true },
  async run({ text }) {
    return { content: `echo: ${text}`, untrusted: false };
  },
});
const send = defineTool({
  name: "test.send",
  description: "Send (not idempotent)",
  input: z.object({ to: z.string() }),
  annotations: { outbound: true },
  async run() {
    sent += 1;
    return { content: "sent", untrusted: false };
  },
  async site({ to }) {
    siteAsked += 1;
    return to.endsWith(".example") ? to : null;
  },
});

function executor(
  grants: AgentProfile["grants"],
  extra: {
    policy?: PolicyEngine;
    calls?: ToolCallStore;
    redact?: (c: RunContext, t: string) => Promise<string>;
  } = {},
) {
  const agent = agentWith(grants);
  const agents = { get: async () => agent };
  return createToolExecutor({
    registry: createToolRegistry([echo, send] as unknown as ToolDefinition<never>[]),
    policy: extra.policy ?? createPolicyEngine({ agents }),
    calls: extra.calls ?? memoryCalls(),
    agents,
    redact: extra.redact,
    maxResultChars: 50,
  });
}

const request = (name: string, args: unknown, key = "r:tool-0-0", tainted = false) => ({
  name,
  args,
  toolCallId: "tool-0-0",
  idempotencyKey: key,
  tainted,
});

describe("tool executor", () => {
  it("lists only granted, unblocked tools", async () => {
    const e = executor([
      { tool: "test.echo", mode: "auto" },
      { tool: "test.send", mode: "blocked" },
    ]);
    expect((await e.listTools(ctx)).map((t) => t.name)).toEqual(["test.echo"]);
  });

  it("runs a granted tool and checks its arguments first", async () => {
    const e = executor([{ tool: "test.echo", mode: "auto" }]);
    expect(await e.execute(request("test.echo", { text: "hi" }), ctx)).toMatchObject({
      status: "ok",
      content: "echo: hi",
    });
    expect(await e.execute(request("test.echo", { text: "" }, "k2"), ctx)).toMatchObject({
      status: "error",
      code: "invalid_args",
    });
    expect(await e.execute(request("nope", {}, "k3"), ctx)).toMatchObject({
      status: "error",
      code: "unknown_tool",
    });
  });

  it("blocks what policy denies or wants approved", async () => {
    const e = executor([{ tool: "test.send", mode: "auto" }]);
    expect(await e.execute(request("test.echo", { text: "x" }), ctx)).toMatchObject({
      status: "blocked",
      verdict: "deny",
    });
    const tainted = await e.execute(request("test.send", { to: "x" }, "k4", true), ctx);
    expect(tainted).toMatchObject({
      status: "blocked",
      verdict: "approve",
      summary: 'test.send {"to":"x"}',
    });
  });

  it("in a tainted run, names the site a person can allow, and honours an allowed one", async () => {
    const e = executor([{ tool: "test.send", mode: "auto" }]);
    siteAsked = 0;
    expect(await e.execute(request("test.send", { to: "shop.example" }, "s1"), ctx)).toMatchObject({
      status: "ok",
    });
    expect(siteAsked).toBe(0); // Not tainted: the site does not matter.
    expect(
      await e.execute(request("test.send", { to: "shop.example" }, "s2", true), ctx),
    ).toMatchObject({ status: "blocked", verdict: "approve", allowSite: "shop.example" });
    const allowed = {
      ...request("test.send", { to: "shop.example" }, "s3", true),
      allowedSites: ["shop.example"],
    };
    expect(await e.execute(allowed, ctx)).toMatchObject({ status: "ok", verdict: "auto" });
    const elsewhere = { ...allowed, args: { to: "evil.example" }, idempotencyKey: "s4" };
    expect(await e.execute(elsewhere, ctx)).toMatchObject({
      status: "blocked",
      allowSite: "evil.example",
    });
  });

  it("offers a held call's written text for editing, only where the agent wrote some (ADR-0030)", async () => {
    const post = defineJsonSchemaTool({
      name: "test.post",
      description: "Post",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string" },
          text: { type: "string" },
          title: { type: "string" },
        },
      },
      annotations: { outbound: true },
      editable: ["text", "title"],
      showArgs: true,
      async run() {
        return { content: "posted", untrusted: false };
      },
    });
    const agent = agentWith([{ tool: "test.post", mode: "approve" }]);
    const agents = { get: async () => agent };
    const e = createToolExecutor({
      registry: createToolRegistry([post] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
    });
    expect(
      await e.execute(request("test.post", { channel: "c1", text: "Hello" }), ctx),
    ).toMatchObject({ status: "blocked", editable: ["text"], showArgs: true });
  });

  it("runs a held call once a person approved it, but never a denied one", async () => {
    const before = sent;
    const e = executor([{ tool: "test.send", mode: "approve" }]);
    const approved = { ...request("test.send", { to: "x" }, "k5"), approved: true };
    expect(await e.execute(approved, ctx)).toMatchObject({ status: "ok", verdict: "approve" });
    expect(sent).toBe(before + 1);
    const denied = executor([{ tool: "test.send", mode: "blocked" }]);
    expect(await denied.execute({ ...approved, idempotencyKey: "k6" }, ctx)).toMatchObject({
      status: "blocked",
      verdict: "deny",
    });
    expect(sent).toBe(before + 1);
  });

  it("never repeats a call that finished, and refuses to guess after a crash", async () => {
    const calls = memoryCalls();
    const e = executor([{ tool: "test.send", mode: "auto" }], { calls });
    sent = 0;
    await e.execute(request("test.send", { to: "x" }, "once"), ctx);
    expect(await e.execute(request("test.send", { to: "x" }, "once"), ctx)).toMatchObject({
      status: "ok",
      content: "sent",
    });
    expect(sent).toBe(1);

    calls.rows.set("crashed", { status: "in_flight", result: null, untrusted: false });
    expect(await e.execute(request("test.send", { to: "x" }, "crashed"), ctx)).toMatchObject({
      status: "error",
      code: "uncertain",
    });
    expect(sent).toBe(1);
  });

  it("redacts and size-limits what the model sees", async () => {
    const e = executor([{ tool: "test.echo", mode: "auto" }], {
      redact: async (_c, t) => t.replaceAll("hunter22-secret", "[REDACTED]"),
    });
    const out = await e.execute(
      request("test.echo", { text: `hunter22-secret ${"z".repeat(100)}` }),
      ctx,
    );
    expect(out.status === "ok" && out.content).toMatch(
      /^echo: \[REDACTED\] z+\n…\[cut: \d+ more characters\]$/,
    );
  });

  it("describes tools with JSON Schema", () => {
    expect(toDescriptor(echo as never).inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
    });
  });
});

describe("editable text (ADR-0030)", () => {
  it("offers written text, never identifiers, addresses, choices or patterns", () => {
    expect(
      editableTextFields({
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: ["string", "null"] },
          page_title: { type: "string" },
          thread_id: { type: "string" },
          description: { type: "string", enum: ["a", "b"] },
          summary: { type: "string", format: "uri" },
          comment: { type: "string", pattern: "^x" },
          message: { type: "object" },
          notes: { type: ["string", "number"] },
        },
      }),
    ).toEqual(["subject", "body", "page_title"]);
    expect(editableTextFields({ type: "object" })).toEqual([]);
  });
});

describe("tools described by JSON Schema (M2.29)", () => {
  // The shape an MCP server sends: no zod, only JSON Schema.
  const schema = {
    type: "object",
    properties: {
      to: { type: "string", format: "email" },
      subject: { type: "string", minLength: 1, maxLength: 200 },
      priority: { type: "string", enum: ["low", "high"] },
    },
    required: ["to", "subject"],
    additionalProperties: false,
  };
  let ran = 0;
  const draft = defineJsonSchemaTool({
    name: "mail.create_draft",
    description: "Create a draft",
    inputSchema: schema,
    annotations: {},
    source: "mcp",
    async run(args) {
      ran += 1;
      return { content: args as Record<string, unknown>, untrusted: false };
    },
  });
  const registry = createToolRegistry([draft as ToolDefinition<never>]);

  it("checks arguments against the schema, with messages the model can act on", () => {
    expect(registry.validate("mail.create_draft", { to: "a@b.co", subject: "Hi" })).toEqual({
      ok: true,
      value: { to: "a@b.co", subject: "Hi" },
    });
    const bad = (args: unknown) => {
      const result = registry.validate("mail.create_draft", args);
      return result.ok ? "ok" : result.message;
    };
    expect(bad({ to: "a@b.co" })).toMatch(/^subject: /);
    expect(bad({ to: "not an address", subject: "Hi" })).toMatch(/^to: Invalid email/);
    expect(bad({ to: "a@b.co", subject: "Hi", priority: "urgent" })).toMatch(/^priority: /);
    expect(bad({ to: "a@b.co", subject: "Hi", cc: "x" })).toMatch(/Unrecognized key: "cc"/);
    expect(bad(undefined)).toMatch(/to: .*; subject: /);
    expect(registry.validate("mail.send", {})).toEqual({
      ok: false,
      message: "No tool named mail.send",
    });
  });

  it("shows the model the schema it was given, unchanged", () => {
    expect(registry.descriptors()[0]).toMatchObject({ inputSchema: schema, source: "mcp" });
  });

  it("follows shared definitions in older schemas", () => {
    const tool = defineJsonSchemaTool({
      name: "crm.find",
      description: "Find",
      inputSchema: {
        type: "object",
        properties: { id: { $ref: "#/definitions/id" } },
        required: ["id"],
        definitions: { id: { type: "string", minLength: 3 } },
      },
      annotations: { readOnly: true },
      run: async () => ({ content: "", untrusted: false }),
    });
    expect(tool.input.safeParse({ id: "abc" }).success).toBe(true);
    expect(tool.input.safeParse({ id: "a" }).success).toBe(false);
  });

  it("refuses a schema it cannot check when the tool is defined, not mid-run", () => {
    expect(() =>
      defineJsonSchemaTool({
        name: "odd.tool",
        description: "Odd",
        inputSchema: { type: "weird" },
        annotations: {},
        run: async () => ({ content: "", untrusted: false }),
      }),
    ).toThrow(new ToolSchemaError("odd.tool: Unsupported input schema: Unsupported type: weird"));
  });

  it("sends a malformed call back before policy, the call record or the tool", async () => {
    const agents = { get: async () => agentWith([{ tool: "mail.create_draft", mode: "auto" }]) };
    let policyCalls = 0;
    const calls = memoryCalls();
    const e = createToolExecutor({
      registry,
      policy: {
        async evaluate() {
          policyCalls += 1;
          return { verdict: "auto", reasons: [] };
        },
      },
      calls,
      agents,
    });
    ran = 0;
    const outcome = await e.execute(request("mail.create_draft", { to: "a@b.co" }), ctx);
    expect(outcome).toMatchObject({ status: "error", code: "invalid_args" });
    expect([policyCalls, calls.rows.size, ran]).toEqual([0, 0, 0]);
    const good = await e.execute(
      request("mail.create_draft", { to: "a@b.co", subject: "Hi" }, "k2"),
      ctx,
    );
    expect(good).toMatchObject({ status: "ok" });
    expect([policyCalls, calls.rows.size, ran]).toEqual([1, 1, 1]);
  });
});

describe("built-in tools", () => {
  const records: MemoryRecord[] = [];
  const memory: MemoryStore = {
    async write(_ctx, write) {
      const record = {
        ...write,
        id: asId<never>(`m${records.length}`),
        createdAt: new Date("2026-10-02"),
      };
      records.push(record);
      return record;
    },
    async recall() {
      return records;
    },
  };
  const tools = createToolRegistry(builtinTools({ memory, search: null }));
  const runCtx = { ...ctx, idempotencyKey: "k", tainted: true, memoryScopes: ["agent" as const] };

  it("remembers facts unverified in a tainted run, and recalls them", async () => {
    const remember = tools.get("remember")!;
    const result = await remember.run(
      { fact: "Sam prefers short answers", kind: "preference" },
      runCtx,
    );
    expect(result.content).toMatch(/unverified/);
    expect(records[0]).toMatchObject({ scope: "agent", verified: false, kind: "preference" });
    // A scope this agent may not use falls back to its own memory.
    await remember.run({ fact: "Shared with everyone", kind: "fact", scope: "workspace" }, runCtx);
    expect(records[1]).toMatchObject({ scope: "agent" });
    const recall = await tools.get("recall")!.run({ query: "answers", limit: 5 }, runCtx);
    expect(JSON.stringify(recall.content)).toContain("Sam prefers short answers");
  });

  it("says plainly when search is not set up", async () => {
    await expect(
      tools.get("web.search")!.run({ query: "x y", max_results: 3 }, runCtx),
    ).rejects.toThrow(/SEARXNG_URL/);
  });

  it("reads SearXNG results, de-duplicated and limited", async () => {
    const fakeFetch = (async () =>
      Response.json({
        results: [
          { title: "A", url: "https://a.example", content: "first" },
          { title: "A again", url: "https://a.example", content: "dup" },
          { title: "B", url: "https://b.example", content: null },
        ],
      })) as unknown as typeof fetch;
    const results = await createSearxngProvider({
      baseUrl: "http://searxng:8080",
      fetch: fakeFetch,
    }).search("q", { limit: 5 });
    expect(results).toEqual([
      { title: "A", url: "https://a.example", snippet: "first" },
      { title: "B", url: "https://b.example", snippet: "" },
    ]);
  });

  it("reads long pages a chunk at a time and says how to read on", async () => {
    const body = `${"a".repeat(READ_CHUNK_CHARS)}${"b".repeat(100)}`;
    const reader = createToolRegistry(
      builtinTools({
        memory,
        search: null,
        fetcher: async (url) => ({
          url,
          status: 200,
          contentType: "text/plain",
          body,
          truncated: false,
        }),
      }),
    ).get("web.read_url")!;
    const first = await reader.run({ url: "https://a.example/long", from: 0 }, runCtx);
    expect(first.content).toMatch(/from: 6000 to read more/);
    expect(String(first.content)).not.toContain("b");
    const rest = await reader.run({ url: "https://a.example/long", from: 6_000 }, runCtx);
    expect(String(rest.content)).toContain("b".repeat(100));
    expect(rest.content).not.toMatch(/read more/);
  });
});

describe("safe fetch", () => {
  it("knows private and special addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses localhost, private IPs, odd schemes and credentials before connecting", async () => {
    await expect(safeFetch("http://127.0.0.1:3000/api/health")).rejects.toThrow(/private/);
    await expect(safeFetch("http://localhost:3000/")).rejects.toThrow(/private/);
    await expect(safeFetch("http://[::1]/")).rejects.toThrow(/private/);
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/http and https/);
    await expect(safeFetch("https://user:pw@example.com/")).rejects.toThrow(/credentials/);
  });

  it("turns HTML into readable text", () => {
    const html = `<html><head><title>T</title><script>alert(1)</script></head><body><h1>Title</h1><p>Hello&nbsp;<b>world</b> &amp; you</p><ul><li>one</li><li>two</li></ul></body></html>`;
    expect(htmlToText(html)).toBe("# Title\nHello world & you\n\n- one\n- two");
  });
});
