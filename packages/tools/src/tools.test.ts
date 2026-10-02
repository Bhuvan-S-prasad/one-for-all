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
  defineTool,
  htmlToText,
  isPrivateAddress,
  safeFetch,
  toDescriptor,
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
    expect(tainted).toMatchObject({ status: "blocked", verdict: "approve" });
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
