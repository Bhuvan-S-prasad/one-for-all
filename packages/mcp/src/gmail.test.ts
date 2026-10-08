import { asId, type AgentProfile, type RunContext, type ToolCallStore } from "@ofa/core";
import { createPolicyEngine } from "@ofa/policy";
import { createToolExecutor, createToolRegistry, type ToolDefinition } from "@ofa/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlainEmail, encodeWord, MimeError, parseRecipients } from "./extras/mime";
import {
  CATALOG,
  createMcpConnections,
  createMcpToolkits,
  createMemoryConnectionStore,
  startFakeMcpServer,
  testCipher,
  type CatalogEntry,
  type FakeMcpServer,
} from "./index";

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("alice"),
  agentId: asId("agent"),
  runId: asId("run"),
};
const REDIRECT = "http://localhost:3000/api/connections/callback";

describe("plain email (ADR-0031)", () => {
  it("builds headers that can't be broken into, and a base64 body", () => {
    const text = buildPlainEmail({
      to: "Sam Rivera <sam@rivera.example>, lee@example.com",
      subject: "Café on Tuesday ☕",
      body: "Line one\nLine two",
      inReplyTo: "<abc@rivera.example>",
      references: "<x@a.example> <abc@rivera.example>",
    });
    const [head, body] = text.split("\r\n\r\n");
    expect(head!.split("\r\n")).toEqual([
      'To: "Sam Rivera" <sam@rivera.example>, lee@example.com',
      `Subject: ${encodeWord("Café on Tuesday ☕")}`,
      "In-Reply-To: <abc@rivera.example>",
      "References: <x@a.example> <abc@rivera.example>",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
    expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(
      "Line one\r\nLine two",
    );
  });

  it("refuses anything that would start a header or hide a recipient", () => {
    const bad = (f: () => unknown) => expect(f).toThrow(MimeError);
    bad(() => parseRecipients("To", "sam@rivera.example\r\nBcc: eve@evil.example"));
    bad(() => parseRecipients("To", "not an address"));
    bad(() => parseRecipients("To", 'Eve "x" <eve@evil.example>'));
    bad(() =>
      parseRecipients("To", Array.from({ length: 21 }, (_, i) => `a${i}@x.example`).join(",")),
    );
    bad(() =>
      buildPlainEmail({ to: "a@x.example", subject: "Hi\r\nBcc: eve@evil.example", body: "x" }),
    );
    bad(() =>
      buildPlainEmail({ to: "a@x.example", subject: "Hi", body: "x", inReplyTo: "<a>\r\nX: y" }),
    );
    bad(() => buildPlainEmail({ to: "", subject: "Hi", body: "x" }));
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

describe("Gmail through Google's API, without an MCP server (ADR-0031)", () => {
  let fake: FakeMcpServer;
  beforeEach(async () => {
    // Like accounts.google.com: an OAuth server and nothing about MCP.
    fake = await startFakeMcpServer({ protectedResource: false });
  });
  afterEach(() => fake.close());

  async function signedIn() {
    const store = createMemoryConnectionStore();
    // Not parsed: the catalog only takes https, and the fake is http on 127.0.0.1.
    const entry: CatalogEntry = {
      ...CATALOG.find((e) => e.id === "gmail")!,
      url: fake.url,
      authOrigin: fake.url,
      apiOrigins: [fake.url],
      // The fake registers clients itself; Google needs your own (the guide).
      setup: "automatic",
    };
    const mcp = createMcpConnections({
      store,
      cipher: testCipher,
      redirectUrl: REDIRECT,
      catalog: [entry],
    });
    const server = await mcp.install(ctx, "gmail");
    const start = await mcp.startSignIn(ctx, server.id);
    if (start.status !== "redirect") throw new Error("expected a sign-in address");
    const signIn = new URL(start.authorizationUrl);
    const back = new URL(
      (await fetch(signIn, { redirect: "manual" })).headers.get("location") ?? "",
    );
    await mcp.finishSignIn(ctx, {
      code: back.searchParams.get("code") ?? "",
      state: back.searchParams.get("state") ?? "",
      issuer: back.searchParams.get("iss") ?? "",
    });
    const toolkits = createMcpToolkits({ connections: store, mcp, catalog: [entry] });
    const agent = {
      id: ctx.agentId,
      grants: [{ tool: "gmail.*", mode: "auto" }],
      memoryScopes: [],
    } as unknown as AgentProfile;
    const agents = { get: async () => agent };
    const executor = createToolExecutor({
      registry: createToolRegistry([] as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
      toolkits,
    });
    return { store, mcp, server, toolkits, executor, signIn };
  }

  const call = (name: string, args: unknown, step: string, extra = {}) => ({
    name,
    args,
    toolCallId: step,
    idempotencyKey: `run:${step}`,
    tainted: false,
    ...extra,
  });

  it("signs in at the sign-in site itself, and keeps its own tools as the app's list", async () => {
    const { signIn, toolkits, store, server, mcp, executor } = await signedIn();
    expect(signIn.origin).toBe(fake.url);
    expect(signIn.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    );
    expect(signIn.searchParams.get("access_type")).toBe("offline");
    // No MCP server, so no resource to name.
    expect(signIn.searchParams.has("resource")).toBe(false);
    expect((await store.getConnection(ctx, server.id))?.status).toBe("active");

    expect(await toolkits.refresh(ctx, server.id)).toBe(5);
    expect(store.servers.get(server.id)?.tools?.map((t) => t.name)).toEqual([
      "search_messages",
      "read_message",
      "create_draft",
      "send_email",
      "send_draft",
    ]);
    expect((await executor.listTools(ctx)).map((t) => t.name).sort()).toEqual([
      "gmail.create_draft",
      "gmail.read_message",
      "gmail.search_messages",
      "gmail.send_draft",
      "gmail.send_email",
    ]);
    await expect(mcp.connect(ctx, server.id)).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("searches and reads mail as outside content, HTML as text", async () => {
    const { executor, toolkits, server } = await signedIn();
    await toolkits.refresh(ctx, server.id);
    fake.gmail.addMessage({
      id: "m1",
      threadId: "t1",
      from: "Sam Rivera <sam@rivera.example>",
      to: "alex@example.com",
      subject: "Lunch on Tuesday?",
      body: "Free at 12:30?",
    });
    fake.gmail.addMessage({
      id: "m2",
      from: "News <news@shop.example>",
      to: "alex@example.com",
      subject: "Weekly deals",
      body: "Big <b>savings</b> inside",
      html: true,
    });
    const found = await executor.execute(
      call("gmail.search_messages", { query: "lunch" }, "t1"),
      ctx,
    );
    expect(found).toMatchObject({ status: "ok", untrusted: true, verdict: "auto" });
    expect(found.status === "ok" && found.content).toContain("m1 · ");
    expect(found.status === "ok" && found.content).not.toContain("Weekly deals");

    const read = await executor.execute(
      call("gmail.read_message", { message_id: "m2" }, "t2"),
      ctx,
    );
    expect(read).toMatchObject({ status: "ok", untrusted: true });
    expect(read.status === "ok" && read.content).toContain("Big savings inside");
    expect(read.status === "ok" && read.content).not.toContain("<b>");
  });

  it("sends only what a person approved, replying in the thread", async () => {
    const { executor, toolkits, server } = await signedIn();
    await toolkits.refresh(ctx, server.id);
    fake.gmail.addMessage({
      id: "m1",
      threadId: "t1",
      from: "Sam Rivera <sam@rivera.example>",
      to: "alex@example.com",
      subject: "Lunch on Tuesday?",
      body: "Free at 12:30?",
      messageId: "<abc@rivera.example>",
    });
    const args = {
      to: "sam@rivera.example",
      subject: "Re: Lunch on Tuesday?",
      body: "Yes, 12:30 works.",
      reply_to_message_id: "m1",
    };
    // An app granted whole: sending asks first, as a draft card.
    const held = await executor.execute(call("gmail.send_email", args, "t1"), ctx);
    expect(held).toMatchObject({
      status: "blocked",
      verdict: "approve",
      summary: "Send the email to sam@rivera.example: “Re: Lunch on Tuesday?”",
      editable: ["subject", "body"],
      showArgs: true,
    });
    expect(fake.gmail.sent).toEqual([]);

    const sent = await executor.execute(
      call("gmail.send_email", args, "t1", { approved: true }),
      ctx,
    );
    expect(sent).toMatchObject({ status: "ok", verdict: "approve" });
    expect(fake.gmail.sent).toHaveLength(1);
    expect(fake.gmail.sent[0]).toMatchObject({
      to: "sam@rivera.example",
      subject: "Re: Lunch on Tuesday?",
      body: "Yes, 12:30 works.",
      threadId: "t1",
      headers: { "in-reply-to": "<abc@rivera.example>" },
    });
  });

  it("sends back a recipient that would hide another, before anyone is asked", async () => {
    const { executor, toolkits, server } = await signedIn();
    await toolkits.refresh(ctx, server.id);
    const sneaky = await executor.execute(
      call(
        "gmail.send_email",
        { to: "sam@rivera.example\r\nBcc: eve@evil.example", subject: "Hi", body: "Hello" },
        "t1",
      ),
      ctx,
    );
    expect(sneaky).toMatchObject({ status: "error", code: "invalid_args" });
    expect(fake.gmail.sent).toEqual([]);
  });

  it("saves a draft, then sends that draft once approved", async () => {
    const { executor, toolkits, server } = await signedIn();
    await toolkits.refresh(ctx, server.id);
    const draft = { to: "lee@example.com", subject: "Café ☕", body: "See you there." };
    expect(await executor.execute(call("gmail.create_draft", draft, "t1"), ctx)).toMatchObject({
      status: "blocked",
      summary: "Save a Gmail draft to lee@example.com: “Café ☕”",
    });
    const saved = await executor.execute(
      call("gmail.create_draft", draft, "t1", { approved: true }),
      ctx,
    );
    expect(saved).toMatchObject({ status: "ok" });
    expect(fake.gmail.saved[0]).toMatchObject({ to: "lee@example.com", subject: "Café ☕" });
    const draftId = /draft_\d+/.exec(saved.status === "ok" ? saved.content : "")?.[0] ?? "";

    expect(
      await executor.execute(call("gmail.send_draft", { draft_id: draftId }, "t2"), ctx),
    ).toMatchObject({
      status: "blocked",
      summary: "Send the email “Café ☕” to lee@example.com\nSee you there.",
    });
    await executor.execute(
      call("gmail.send_draft", { draft_id: draftId }, "t2", { approved: true }),
      ctx,
    );
    expect(fake.gmail.sentDrafts).toEqual([draftId]);
  });
});
