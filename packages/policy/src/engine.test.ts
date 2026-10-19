import {
  asId,
  type AgentGrantRule,
  type AgentProfile,
  type PolicyRule,
  type RunContext,
  type ToolDescriptor,
} from "@ofa/core";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, grantFor, humanOnlyKind } from "./index";

const ctx: RunContext = {
  workspaceId: asId("ws"),
  userId: asId("u"),
  agentId: asId("a"),
  runId: asId("r"),
};

function engine(grants: AgentGrantRule[], rules: PolicyRule[] = []) {
  const agent = { id: ctx.agentId, grants } as unknown as AgentProfile;
  return createPolicyEngine({
    agents: { get: async () => agent },
    rules: { listForRun: async () => rules },
  });
}

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, "tool" | "effect">): PolicyRule => ({
  id: r.tool,
  scope: "workspace",
  agentId: null,
  description: "",
  ...r,
});

const tool = (name: string, annotations: ToolDescriptor["annotations"] = {}): ToolDescriptor => ({
  name,
  description: "",
  inputSchema: {},
  annotations,
  source: "builtin",
});

describe("policy engine", () => {
  it("denies tools that are not granted, or blocked", async () => {
    const e = engine([{ tool: "web.search", mode: "blocked" }]);
    expect(
      (await e.evaluate({ ctx, tool: tool("gmail.send"), args: {}, tainted: false })).verdict,
    ).toBe("deny");
    expect(
      (await e.evaluate({ ctx, tool: tool("web.search"), args: {}, tainted: false })).verdict,
    ).toBe("deny");
  });

  it("uses the grant's mode, with exact names beating app wildcards", async () => {
    const grants: AgentGrantRule[] = [
      { tool: "hubspot.*", mode: "approve" },
      { tool: "hubspot.search", mode: "auto" },
    ];
    expect(grantFor(grants, "hubspot.search")?.mode).toBe("auto");
    expect(grantFor(grants, "hubspot.update")?.mode).toBe("approve");
    expect(grantFor(grants, "remember")).toBeUndefined();
  });

  it("escalates outbound tools in a tainted run, and destructive tools always", async () => {
    const e = engine([
      { tool: "gmail.send", mode: "auto" },
      { tool: "files.overwrite", mode: "auto" },
    ]);
    const send = tool("gmail.send", { outbound: true });
    expect((await e.evaluate({ ctx, tool: send, args: {}, tainted: false })).verdict).toBe("auto");
    const tainted = await e.evaluate({ ctx, tool: send, args: {}, tainted: true });
    expect(tainted.verdict).toBe("approve");
    expect(tainted.reasons.join(" ")).toMatch(/untrusted/);
    const overwrite = tool("files.overwrite", { destructive: true });
    expect((await e.evaluate({ ctx, tool: overwrite, args: {}, tainted: false })).verdict).toBe(
      "approve",
    );
  });

  it("holds a paid call for a person whatever the grant, naming the estimate (EN.15)", async () => {
    const e = engine([{ tool: "runway.generate_video", mode: "auto" }]);
    const paid = tool("runway.generate_video", { costUsd: 0.5 });
    const held = await e.evaluate({ ctx, tool: paid, args: {}, tainted: false });
    expect(held.verdict).toBe("approve");
    expect(held.reasons.join(" ")).toContain("about $0.50 a call");
    const free = tool("runway.generate_video", { costUsd: 0 });
    expect((await e.evaluate({ ctx, tool: free, args: {}, tainted: false })).verdict).toBe("auto");
  });

  it("in a tainted run, opens only addresses the run was given", async () => {
    const e = engine([{ tool: "browser.*", mode: "auto" }]);
    const open = tool("browser.open", { readOnly: true, opensUrl: "url" });
    const knownUrls = new Set(["https://shop.example/orders/5512"]);
    const ask = (url: string, tainted = true) =>
      e.evaluate({ ctx, tool: open, args: { url }, tainted, knownUrls });
    // Given (however it is written): no question.
    expect((await ask("https://www.shop.example/orders/5512/")).verdict).toBe("auto");
    // Data after `#` reaches the page's script: an added fragment wasn't given.
    expect((await ask("https://shop.example/orders/5512#email=sam@example.com")).verdict).toBe(
      "approve",
    );
    // Made up, with data in it: a person decides.
    const made = await ask("https://verify-orders.example/check?email=sam@example.com");
    expect(made.verdict).toBe("approve");
    expect(made.reasons.join(" ")).toMatch(/address/);
    // Before reading anything outside, any address is fine.
    expect((await ask("https://anything.example/", false)).verdict).toBe("auto");
  });
});

describe("the always-human list", () => {
  it("classifies by annotation, or by the action's words unless read-only", () => {
    expect(humanOnlyKind(tool("stripe.make", { humanOnly: "payment" }))).toBe("payment");
    expect(humanOnlyKind(tool("gmail.delete_message"))).toBe("deletion");
    expect(humanOnlyKind(tool("stripe.create_refund"))).toBe("payment");
    expect(humanOnlyKind(tool("drive.share_file"))).toBe("sharing");
    expect(humanOnlyKind(tool("github.update_permissions"))).toBe("permissions");
    expect(humanOnlyKind(tool("notion.list_deleted"))).toBeNull();
    expect(humanOnlyKind(tool("gmail.remove_label"))).toBeNull();
    expect(humanOnlyKind(tool("github.list_roles", { readOnly: true }))).toBeNull();
    expect(humanOnlyKind(tool("browser.click", { outbound: true }))).toBeNull();
    // Sending the person a file in the app (DT.07) isn't sharing with others;
    // that's why it is files.send and not files.share.
    expect(humanOnlyKind(tool("files.send", { idempotent: true }))).toBeNull();
    expect(humanOnlyKind(tool("files.share"))).toBe("sharing");
    expect(humanOnlyKind(tool("desktop.open", { idempotent: true }))).toBeNull();
  });

  it("needs a person whatever the grant and rules say", async () => {
    const e = engine(
      [{ tool: "gmail.*", mode: "auto" }],
      [rule({ tool: "gmail.*", effect: "allow_auto" })],
    );
    const decision = await e.evaluate({
      ctx,
      tool: tool("gmail.delete_message"),
      args: {},
      tainted: false,
    });
    expect(decision.verdict).toBe("human");
    expect(decision.reasons.join(" ")).toMatch(/deleting things always needs a person/);
  });
});

describe("rules", () => {
  const search = tool("web.search", { readOnly: true });
  const send = tool("gmail.send", { outbound: true });

  it("ask-first rules hold a call, workspace and personal alike", async () => {
    const workspace = engine(
      [{ tool: "gmail.send", mode: "auto" }],
      [rule({ tool: "gmail.*", effect: "ask_first", description: "Mail goes to customers" })],
    );
    const held = await workspace.evaluate({ ctx, tool: send, args: {}, tainted: false });
    expect(held.verdict).toBe("approve");
    expect(held.reasons).toContain("asks first by a workspace rule: Mail goes to customers");

    const personal = engine(
      [{ tool: "web.search", mode: "auto" }],
      [rule({ tool: "*", effect: "ask_first", scope: "personal" })],
    );
    const mine = await personal.evaluate({ ctx, tool: search, args: {}, tainted: false });
    expect(mine.verdict).toBe("approve");
  });

  it("allow-auto replaces the grant's mode, only when nothing above fired", async () => {
    const e = engine(
      [{ tool: "gmail.send", mode: "approve" }],
      [rule({ tool: "gmail.send", effect: "allow_auto" })],
    );
    const quiet = await e.evaluate({ ctx, tool: send, args: {}, tainted: false });
    expect(quiet.verdict).toBe("auto");
    expect(quiet.reasons[0]).toMatch(/runs without asking by a workspace rule/);
    // Taint escalation fired: the rule does not apply.
    const tainted = await e.evaluate({ ctx, tool: send, args: {}, tainted: true });
    expect(tainted.verdict).toBe("approve");
  });

  it("ignores a personal allow-auto rule, and never loosens a deny", async () => {
    const personal = engine(
      [{ tool: "gmail.send", mode: "approve" }],
      [rule({ tool: "gmail.send", effect: "allow_auto", scope: "personal" })],
    );
    const mine = await personal.evaluate({ ctx, tool: send, args: {}, tainted: false });
    expect(mine.verdict).toBe("approve");
    const blocked = engine(
      [{ tool: "gmail.send", mode: "blocked" }],
      [rule({ tool: "*", effect: "allow_auto" })],
    );
    const no = await blocked.evaluate({ ctx, tool: send, args: {}, tainted: false });
    expect(no.verdict).toBe("deny");
  });
});

describe("allowing a site for the rest of the run", () => {
  const click = tool("browser.click", { outbound: true });
  const open = tool("browser.open", { readOnly: true, opensUrl: "url" });

  it("offers it when only taint escalation held a call on a known site", async () => {
    const e = engine([{ tool: "browser.*", mode: "auto" }]);
    const held = await e.evaluate({
      ctx,
      tool: click,
      args: {},
      tainted: true,
      site: "shop.example",
    });
    expect(held).toMatchObject({ verdict: "approve", allowSite: "shop.example" });
    // No site known: one-off answers only.
    const unknown = await e.evaluate({ ctx, tool: click, args: {}, tainted: true });
    expect(unknown.allowSite).toBeUndefined();
  });

  it("once allowed, calls on that site run, and other sites still ask", async () => {
    const e = engine([{ tool: "browser.*", mode: "auto" }]);
    const allowedSites = new Set(["shop.example"]);
    const there = await e.evaluate({
      ctx,
      tool: click,
      args: {},
      tainted: true,
      site: "shop.example",
      allowedSites,
    });
    expect(there.verdict).toBe("auto");
    expect(there.reasons).toContain("allowed on shop.example for this task");
    const made = await e.evaluate({
      ctx,
      tool: open,
      args: { url: "https://shop.example/check?email=sam@example.com" },
      tainted: true,
      site: "shop.example",
      allowedSites,
    });
    expect(made.verdict).toBe("auto");
    const elsewhere = await e.evaluate({
      ctx,
      tool: open,
      args: { url: "https://evil.example/?email=sam@example.com" },
      tainted: true,
      site: "evil.example",
      allowedSites,
    });
    expect(elsewhere).toMatchObject({ verdict: "approve", allowSite: "evil.example" });
  });

  it("is not offered, and does not help, when something else holds the call", async () => {
    const approveGrant = engine([{ tool: "browser.*", mode: "approve" }]);
    const granted = await approveGrant.evaluate({
      ctx,
      tool: click,
      args: {},
      tainted: true,
      site: "shop.example",
    });
    expect(granted.allowSite).toBeUndefined();
    const askFirst = engine(
      [{ tool: "browser.*", mode: "auto" }],
      [rule({ tool: "browser.click", effect: "ask_first" })],
    );
    const held = await askFirst.evaluate({
      ctx,
      tool: click,
      args: {},
      tainted: true,
      site: "shop.example",
      allowedSites: new Set(["shop.example"]),
    });
    expect(held.verdict).toBe("approve");
    expect(held.allowSite).toBeUndefined();
    const human = engine([{ tool: "shop.*", mode: "auto" }]);
    const pay = await human.evaluate({
      ctx,
      tool: tool("shop.checkout", { outbound: true }),
      args: {},
      tainted: true,
      site: "shop.example",
      allowedSites: new Set(["shop.example"]),
    });
    expect(pay.verdict).toBe("human");
  });
});

describe("apps granted whole", () => {
  const mcp = (name: string, annotations: ToolDescriptor["annotations"]): ToolDescriptor => ({
    ...tool(name, annotations),
    source: "mcp",
  });

  it("reads run, anything that changes something asks; naming a tool wins", async () => {
    const e = engine([
      { tool: "notion.*", mode: "auto" },
      { tool: "notion.create_pages", mode: "auto" },
    ]);
    const ask = (t: ToolDescriptor) => e.evaluate({ ctx, tool: t, args: {}, tainted: false });
    expect((await ask(mcp("notion.search", { readOnly: true }))).verdict).toBe("auto");
    const write = await ask(mcp("notion.move_pages", { outbound: true }));
    expect(write.verdict).toBe("approve");
    expect(write.reasons[0]).toMatch(/granted as part of notion\.\*/);
    // Granted by name: the person chose auto for it.
    expect((await ask(mcp("notion.create_pages", { outbound: true }))).verdict).toBe("auto");
    // Built-in tools keep their grant as it is.
    const builtin = engine([{ tool: "browser.*", mode: "auto" }]);
    const click = tool("browser.click", { outbound: true });
    expect((await builtin.evaluate({ ctx, tool: click, args: {}, tainted: false })).verdict).toBe(
      "auto",
    );
  });
});

describe("proactive checks (M5.10)", () => {
  it("lets a check read and refuses anything that could change things, whatever the grant", async () => {
    const e = engine([
      { tool: "web.search", mode: "auto" },
      { tool: "gmail.*", mode: "auto" },
    ]);
    const read = await e.evaluate({
      ctx,
      tool: tool("web.search", { readOnly: true }),
      args: {},
      tainted: false,
      readOnly: true,
    });
    expect(read.verdict).toBe("auto");
    const send = await e.evaluate({
      ctx,
      tool: tool("gmail.send", { outbound: true }),
      args: {},
      tainted: false,
      readOnly: true,
    });
    expect(send).toEqual({
      verdict: "deny",
      reasons: [
        "gmail.send can change things, and a background check may only read; say what you would do instead",
      ],
    });
    // Unannotated tools count as able to change things.
    expect(
      (
        await e.evaluate({
          ctx,
          tool: tool("gmail.label"),
          args: {},
          tainted: false,
          readOnly: true,
        })
      ).verdict,
    ).toBe("deny");
  });
});

describe("proactive checks never wait (M5.10)", () => {
  it("refuses what would need a person, instead of asking", async () => {
    const e = engine([{ tool: "web.read_url", mode: "auto" }]);
    const opens = tool("web.read_url", { readOnly: true, opensUrl: "url" });
    // In a tainted run, an address nobody gave it would wait for a person…
    const watched = await e.evaluate({
      ctx,
      tool: opens,
      args: { url: "https://made-up.example/?q=1" },
      tainted: true,
      knownUrls: new Set(),
    });
    expect(watched.verdict).toBe("approve");
    // …but nobody watches a check, so it is refused.
    const check = await e.evaluate({
      ctx,
      tool: opens,
      args: { url: "https://made-up.example/?q=1" },
      tainted: true,
      knownUrls: new Set(),
      readOnly: true,
    });
    expect(check.verdict).toBe("deny");
    expect(check.reasons.at(-1)).toBe(
      "a background check doesn't wait for a person; mention it in your reply instead",
    );
  });
});
