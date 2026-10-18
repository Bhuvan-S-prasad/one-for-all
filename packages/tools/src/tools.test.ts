import {
  asId,
  rosterText,
  type AgentId,
  type AgentProfile,
  type MemoryRecord,
  type MemoryStore,
  type PolicyEngine,
  type RunContext,
  type Scheduler,
  type SkillLibrary,
  type TeamDirectory,
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
  delegateTaskTool,
  editableTextFields,
  messageAgentTool,
  remindMeTool,
  runSkillTool,
  saveSkillTool,
  scheduleTaskTool,
  htmlToText,
  isPrivateAddress,
  LOAD_ALL_LIMIT,
  loadToolkitTool,
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

describe("capability cards (ADR-0044)", () => {
  const tool = (name: string, readOnly = false) =>
    defineTool({
      name,
      description: name,
      input: z.object({}),
      annotations: { readOnly },
      async run() {
        return { content: "ok", untrusted: false };
      },
    });

  it("says what each agent can do, by area, from its grants and connected apps", async () => {
    const researcher: AgentProfile = {
      ...agentWith([
        { tool: "web.search", mode: "auto" },
        { tool: "web.read_url", mode: "auto" },
        { tool: "todo.write", mode: "auto" },
        { tool: "delegate_task", mode: "auto" },
      ]),
      id: asId<AgentId>("res"),
    };
    const inbox: AgentProfile = {
      ...agentWith([
        { tool: "gmail.*", mode: "auto" },
        { tool: "gmail.create_draft", mode: "approve" },
        { tool: "gmail.delete_message", mode: "blocked" },
        { tool: "files.send", mode: "auto" },
        { tool: "files.list", mode: "auto" },
      ]),
      id: asId<AgentId>("inbox"),
    };
    const profiles = new Map([
      ["res", researcher],
      ["inbox", inbox],
    ]);
    const agents = { get: async (_c: unknown, id: string) => profiles.get(id) ?? null };
    const e = createToolExecutor({
      registry: createToolRegistry([
        tool("web.search", true),
        tool("web.read_url", true),
        tool("todo.write"),
        tool("delegate_task"),
        tool("files.send"),
        tool("files.list", true),
      ] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
      toolkits: {
        toolkits: async () => [
          {
            app: "gmail",
            name: "Gmail",
            description: "Mail",
            tools: [
              tool("gmail.search_messages", true),
              tool("gmail.create_draft"),
              tool("gmail.delete_message"),
            ] as unknown as ToolDefinition<unknown>[],
          },
        ],
      },
    });
    const cards = await e.capabilities!(ctx, [asId("res"), asId("inbox"), asId("gone")]);
    expect(cards.get("res")).toEqual([{ area: "web", abilities: ["search", "read pages"] }]);
    expect(cards.get("inbox")).toEqual([
      // files.list folds into its area: on its own it says nothing new.
      { area: "files", abilities: ["send files to the person"] },
      { area: "Gmail", abilities: ["search messages", "create draft (asks first)"] },
    ]);
    expect(cards.has("gone")).toBe(false);
  });

  it("keeps a long roster short: cards until the budget, then one line each", () => {
    const member = (n: number) => ({
      id: asId<AgentId>(`a${n}`),
      slug: `agent${n}`,
      name: `Agent ${n}`,
      job: "Helps",
      capabilities: [{ area: "web", abilities: ["search", "read pages"] }],
    });
    const text = rosterText([member(1), member(2), member(3)], 120);
    expect(text).toBe(
      [
        "- agent1 (Agent 1): Helps",
        "  can: web: search, read pages",
        "- agent2 (Agent 2): Helps",
        "  can: web: search, read pages",
        "- agent3 (Agent 3): Helps",
      ].join("\n"),
    );
  });
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

describe("delegate_task (M5.01)", () => {
  function withTeam(
    members: Awaited<ReturnType<TeamDirectory["members"]>>,
    mode: "auto" | "approve",
  ) {
    const team: TeamDirectory = {
      members: async () => members,
      handoff: async () => {
        throw new Error("the harness makes handoffs, not the tool");
      },
      contacts: async () => [],
      message: async () => {
        throw new Error("not in this test");
      },
    };
    const agent = agentWith([{ tool: "delegate_task", mode }]);
    const agents = { get: async () => agent };
    return createToolExecutor({
      registry: createToolRegistry([delegateTaskTool(team)] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
    });
  }
  const researcher = {
    id: asId<AgentId>("res"),
    slug: "researcher",
    name: "Researcher",
    job: "Research",
  };
  const brief = { agent: "Researcher", brief: "Find the release date of pgvector 0.9." };

  it("names the agents a run can hand work to, and is left out when there are none", async () => {
    const [tool] = await withTeam([researcher], "auto").listTools(ctx);
    expect(tool?.name).toBe("delegate_task");
    expect(tool?.description).toContain(
      "Agents you can hand work to (pick each by what it can do):\n- researcher (Researcher): Research",
    );
    // A run that was itself handed work gets no members: one level deep.
    expect(await withTeam([], "auto").listTools(ctx)).toEqual([]);
  });

  it("shows what each agent can do, from its grants (ADR-0044)", async () => {
    const [tool] = await withTeam(
      [
        { ...researcher, capabilities: [{ area: "web", abilities: ["search", "read pages"] }] },
        { id: asId<AgentId>("idle"), slug: "idle", name: "Idle", job: "Waits", capabilities: [] },
      ],
      "auto",
    ).listTools(ctx);
    expect(tool?.description).toContain(
      [
        "- researcher (Researcher): Research",
        "  can: web: search, read pages",
        "- idle (Idle): Waits",
        "  can: no tools; answers from what it knows",
      ].join("\n"),
    );
  });

  it("checks the agent it names, and lets a person reword a held brief", async () => {
    const run = withTeam([researcher], "auto");
    expect(await run.execute(request("delegate_task", brief), ctx)).toMatchObject({
      status: "ok",
      content: "Handing the work to Researcher. Its result comes back here when it is done.",
    });
    expect(
      await run.execute(request("delegate_task", { ...brief, agent: "nobody" }, "r:tool-1-0"), ctx),
    ).toMatchObject({
      status: "error",
      code: "unknown_agent",
      message: "There is no agent called nobody to hand work to. You can hand work to: researcher.",
    });
    expect(
      await withTeam([researcher], "approve").execute(request("delegate_task", brief), ctx),
    ).toMatchObject({
      status: "blocked",
      verdict: "approve",
      summary: "Hand work to Researcher: “Find the release date of pgvector 0.9.”",
      editable: ["brief"],
    });
  });
});

describe("message_agent (M5.03)", () => {
  it("lists who it can message here, and posts through the team with the call's key", async () => {
    const sent: unknown[] = [];
    const team: TeamDirectory = {
      members: async () => [],
      handoff: async () => {
        throw new Error("not in this test");
      },
      contacts: async () => [
        { id: asId<AgentId>("res"), slug: "researcher", name: "Researcher", job: "Research" },
      ],
      message: async (_ctx, input) => {
        sent.push(input);
        return {
          runId: asId("run_b"),
          messageId: asId("msg_b"),
          agentId: asId<AgentId>("res"),
          agentName: "Researcher",
        };
      },
    };
    const agent = agentWith([{ tool: "message_agent", mode: "auto" }]);
    const agents = { get: async () => agent };
    const run = createToolExecutor({
      registry: createToolRegistry([messageAgentTool(team)] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
    });
    const [tool] = await run.listTools(ctx);
    expect(tool?.description).toContain(
      "Agents you can message here:\n- researcher (Researcher): Research",
    );
    const args = { agent: "researcher", message: "Please check the pgvector release notes." };
    expect(await run.execute(request("message_agent", args), ctx)).toMatchObject({
      status: "ok",
      content: expect.stringMatching(/^Sent to Researcher\. Its reply will appear/),
    });
    expect(sent).toEqual([
      {
        key: "r:tool-0-0",
        agent: "researcher",
        content: "Please check the pgvector release notes.",
      },
    ]);
  });
});

describe("schedule_task and remind_me (M5.07)", () => {
  function setup() {
    const set: unknown[] = [];
    const scheduler: Scheduler = {
      timeZone: async () => "Europe/Paris",
      schedule: async (_ctx, input) => {
        set.push(input);
        return { id: "s1", kind: input.kind, content: input.content, dueAt: input.dueAt };
      },
    };
    const agent = agentWith([
      { tool: "schedule_task", mode: "auto" },
      { tool: "remind_me", mode: "auto" },
    ]);
    const agents = { get: async () => agent };
    const run = createToolExecutor({
      registry: createToolRegistry([
        scheduleTaskTool(scheduler),
        remindMeTool(scheduler),
      ] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
    });
    return { run, set };
  }

  it("tells the model the time now, in the person's zone", async () => {
    const { run } = setup();
    const tools = await run.listTools(ctx);
    expect(tools.map((t) => t.name).sort()).toEqual(["remind_me", "schedule_task"]);
    expect(tools[0]?.description).toMatch(
      /It is now \d{4}-\d{2}-\d{2} \d{2}:\d{2} in the person's time zone \(Europe\/Paris\)/,
    );
  });

  it("sets a reminder at a clock time read in the workspace zone, with the call's key", async () => {
    const { run, set } = setup();
    const year = new Date().getUTCFullYear() + 1;
    const outcome = await run.execute(
      request("remind_me", { at: `${year}-01-15 09:30`, message: "Call the dentist" }),
      ctx,
    );
    expect(outcome).toMatchObject({
      status: "ok",
      content: `Reminder set for ${year}-01-15 09:30 (Europe/Paris). It will be posted in this conversation then.`,
    });
    expect(set).toEqual([
      {
        key: "r:tool-0-0",
        kind: "reminder",
        content: "Call the dentist",
        dueAt: new Date(`${year}-01-15T08:30:00Z`),
      },
    ]);
  });

  it("schedules a task some minutes from now", async () => {
    const { run, set } = setup();
    const before = Date.now();
    const outcome = await run.execute(
      request("schedule_task", { in_minutes: 90, task: "Check whether the pricing page changed." }),
      ctx,
    );
    expect(outcome).toMatchObject({ status: "ok", content: expect.stringContaining("woken") });
    const due = (set[0] as { dueAt: Date }).dueAt.getTime();
    expect(due - before).toBeGreaterThanOrEqual(90 * 60_000);
    expect(due - before).toBeLessThan(91 * 60_000);
  });

  it("refuses a time that has passed, can't be read, or is given twice", async () => {
    const { run, set } = setup();
    const call = (args: unknown) => run.execute(request("remind_me", args), ctx);
    expect(await call({ at: "2020-01-01 09:00", message: "Too late" })).toMatchObject({
      status: "error",
      code: "bad_time",
      message: expect.stringContaining("That time has passed"),
    });
    expect(await call({ at: "next friday", message: "Unclear" })).toMatchObject({
      status: "error",
      code: "bad_time",
    });
    expect(await call({ at: "2099-01-01 09:00", in_minutes: 5, message: "Both" })).toMatchObject({
      status: "error",
      code: "bad_time",
    });
    expect(set).toEqual([]);
  });

  it("isn't listed without a scheduler", async () => {
    const agent = agentWith([{ tool: "remind_me", mode: "auto" }]);
    const agents = { get: async () => agent };
    const run = createToolExecutor({
      registry: createToolRegistry([remindMeTool(null)] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
    });
    expect(await run.listTools(ctx)).toEqual([]);
  });
});

describe("run_skill and save_skill (M5.08)", () => {
  function setup() {
    const saved: unknown[] = [];
    const skills: SkillLibrary = {
      list: async () => [{ slug: "brief", name: "Brief", description: "A three-point brief." }],
      find: async (_ctx, name) =>
        name.replace(/^\//, "") === "brief"
          ? {
              slug: "brief",
              name: "Brief",
              description: "A three-point brief.",
              steps: ["Search", "Write three points"],
            }
          : null,
      save: async (_ctx, input) => {
        saved.push(input);
        return { slug: "weekly-report", status: input.tainted ? "proposed" : "active" };
      },
    };
    const agent = agentWith([
      { tool: "run_skill", mode: "auto" },
      { tool: "save_skill", mode: "auto" },
    ]);
    const agents = { get: async () => agent };
    const run = createToolExecutor({
      registry: createToolRegistry([
        runSkillTool(skills),
        saveSkillTool(skills),
      ] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
    });
    return { run, saved };
  }

  it("lists the agent's skills and hands back a skill's steps", async () => {
    const { run } = setup();
    const tools = await run.listTools(ctx);
    expect(tools.find((t) => t.name === "run_skill")?.description).toContain(
      "Your skills:\n- brief: Brief. A three-point brief.",
    );
    expect(await run.execute(request("run_skill", { skill: "/brief" }), ctx)).toMatchObject({
      status: "ok",
      content: expect.stringContaining("1. Search\n2. Write three points"),
      untrusted: false,
    });
    expect(
      await run.execute(request("run_skill", { skill: "nope" }, "tool-0-1"), ctx),
    ).toMatchObject({
      status: "error",
      code: "unknown_skill",
      message: expect.stringContaining("Your skills: brief."),
    });
  });

  it("saves a skill, as a proposal when the run read outside content", async () => {
    const { run, saved } = setup();
    const args = {
      name: "Weekly report",
      description: "Every Friday",
      steps: ["Collect", "Write"],
    };
    expect(await run.execute(request("save_skill", args), ctx)).toMatchObject({
      status: "ok",
      content: expect.stringContaining("Saved as your skill /weekly-report"),
    });
    const tainted = await run.execute(
      { ...request("save_skill", args, "tool-1-0"), tainted: true },
      ctx,
    );
    expect(tainted).toMatchObject({
      status: "ok",
      content: expect.stringContaining("as a proposal"),
    });
    expect(saved).toMatchObject([{ tainted: false }, { tainted: true }]);
  });

  it("aren't listed without a skill library", async () => {
    const agent = agentWith([
      { tool: "run_skill", mode: "auto" },
      { tool: "save_skill", mode: "auto" },
    ]);
    const agents = { get: async () => agent };
    const run = createToolExecutor({
      registry: createToolRegistry([
        runSkillTool(null),
        saveSkillTool(null),
      ] as unknown as ToolDefinition<never>[]),
      policy: createPolicyEngine({ agents }),
      calls: memoryCalls(),
      agents,
    });
    expect(await run.listTools(ctx)).toEqual([]);
  });
});

describe("load_toolkit", () => {
  const big = {
    app: "notion",
    name: "Notion",
    description: "Pages and databases",
    tools: Array.from({ length: LOAD_ALL_LIMIT + 1 }, (_, i) => ({
      name: `notion.tool_${i}`,
      description: `Tool ${i}\nmore detail`,
    })),
    loaded: false,
  };
  const runCtx = { ...ctx, toolkits: { list: async () => [big] } } as never;

  it("asks the agent to pick from an app too large to load whole, listing its tools", async () => {
    const tool = loadToolkitTool();
    await expect(tool.run({ app: "Notion" }, runCtx)).rejects.toMatchObject({
      code: "choose_tools",
      message: expect.stringContaining(
        `Notion has ${LOAD_ALL_LIMIT + 1} tools, too many to load at once. Call load_toolkit again with app "notion"`,
      ),
    });
    await expect(tool.run({ app: "notion" }, runCtx)).rejects.toThrow("- notion.tool_0: Tool 0\n");
    const picked = await tool.run({ app: "notion", tools: ["tool_1", "notion.tool_2"] }, runCtx);
    expect(picked.content).toBe(
      "Loaded from Notion, for the rest of this task:\n- notion.tool_1: Tool 1\n- notion.tool_2: Tool 2",
    );
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
