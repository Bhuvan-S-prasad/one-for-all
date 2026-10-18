import {
  asId,
  ROSTER_HEADING,
  type AgentId,
  type AgentProfile,
  type RunContext,
  type TeamDirectory,
  type TeamMember,
  type ThreadId,
  type ToolDescriptor,
  type UserId,
  type WorkspaceId,
} from "@ofa/core";
import { describe, expect, it } from "vitest";
import {
  createFakeToolExecutor,
  createMemoryRuntime,
  createMemoStepRunner,
  createScriptedLLM,
  okOutcome,
  runAgent,
  type ScriptedReply,
} from "./index";

// Coordinators (ADR-0044): the team in the system prompt, and the tools a
// teammate has kept off their list, in code rather than by asking.

const threadId = asId<ThreadId>("thread_1");
const ctx: RunContext = {
  workspaceId: asId<WorkspaceId>("ws_1"),
  userId: asId<UserId>("usr_1"),
  agentId: asId<AgentId>("chief"),
  runId: asId("run_1"),
};

const chief: AgentProfile = {
  id: ctx.agentId,
  slug: "chief",
  name: "Chief",
  description: "",
  status: "active",
  job: "Coordinates",
  role: "coordinator",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "calm",
  memoryScopes: [],
  budgets: { steps: 10, tokens: 100_000 },
  grants: [],
};

const descriptor = (name: string, description = name): ToolDescriptor => ({
  name,
  description,
  inputSchema: { type: "object" },
  annotations: { readOnly: name === "web.search" },
  source: "builtin",
});

const members: TeamMember[] = [
  {
    id: asId<AgentId>("inbox"),
    slug: "inbox",
    name: "Gmail agent",
    job: "Drafts email",
    capabilities: [{ area: "Gmail", abilities: ["create draft"], tools: ["gmail.create_draft"] }],
  },
  {
    id: asId<AgentId>("researcher"),
    slug: "researcher",
    name: "Researcher",
    job: "Researches laptops and prices",
    capabilities: [
      { area: "web", abilities: ["search", "read pages"], tools: ["web.search", "web.read_url"] },
    ],
  },
];

function setup(script: ScriptedReply[], options: { profile?: AgentProfile; leads?: boolean } = {}) {
  const runtime = createMemoryRuntime();
  runtime.agents.profiles.set(ctx.agentId, options.profile ?? chief);
  runtime.runs.records.set(ctx.runId, {
    id: ctx.runId,
    agentId: ctx.agentId,
    threadId,
    trigger: "message",
    status: "queued",
    tainted: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
  });
  runtime.threads.messages.set(threadId, [
    {
      id: asId("m1"),
      author: "user",
      agentId: null,
      content: "Compare laptops under $1,200 and draft me an email.",
      createdAt: new Date(),
    },
  ]);
  const tools = createFakeToolExecutor([
    { descriptor: descriptor("web.search"), run: () => okOutcome("[results]", true) },
    { descriptor: descriptor("todo.write"), run: () => okOutcome("Plan saved") },
    { descriptor: descriptor("message_agent"), run: () => okOutcome("Sent.") },
    {
      descriptor: descriptor(
        "delegate_task",
        `Hand a piece of work to another agent.\n${ROSTER_HEADING}\n- researcher (Researcher): …`,
      ),
      run: () => okOutcome("Handing the work over."),
    },
  ]);
  const team: TeamDirectory = {
    members: async () => members,
    contacts: async () => members,
    handoff: async () => {
      throw new Error("not in this test");
    },
    message: async () => {
      throw new Error("not in this test");
    },
  };
  const llm = createScriptedLLM(script);
  const run = () =>
    runAgent(
      { ctx, threadId, trigger: "message" },
      {
        llm,
        tools,
        runs: runtime.runs,
        agents: runtime.agents,
        threads: {
          ...runtime.threads,
          coordinatorOf: async () => (options.leads ? ctx.agentId : null),
        },
        team,
      },
      createMemoStepRunner(),
    );
  return { runtime, llm, tools, run };
}

describe("a coordinator (ADR-0044)", () => {
  it("sees its team in its instructions, without the tools a teammate has", async () => {
    const { llm, run } = setup([{ text: "On it." }]);
    await run();
    const request = llm.requests[0]!;
    const system = request.messages[0]?.content ?? "";
    expect(system).toContain("You coordinate a team.");
    // Ranked by the request: "draft" and "email" match the Gmail agent twice,
    // "laptops" the researcher once.
    expect(system).toContain(
      [
        "Your team:",
        "- inbox (Gmail agent): Drafts email",
        "  can: Gmail: create draft",
        "- researcher (Researcher): Researches laptops and prices",
        "  can: web: search, read pages",
      ].join("\n"),
    );
    expect(request.tools?.map((t) => t.name)).toEqual(["delegate_task", "todo.write"]);
    expect(request.tools?.find((t) => t.name === "delegate_task")?.description).toBe(
      "Hand a piece of work to another agent.\nYour team, with what each one can do, is in your instructions.",
    );
    expect(request.promptVersion).toContain("harness.team@2");
  });

  it("is refused a teammate's tool if it calls it anyway, and nothing runs", async () => {
    const { runtime, llm, tools, run } = setup([
      { toolCalls: [{ name: "web.search", args: { query: "laptops" } }] },
      { text: "I'll ask the researcher." },
    ]);
    await run();
    expect(tools.calls).toEqual([]);
    expect(runtime.runs.events.find((e) => e.type === "tool.failed")?.payload).toMatchObject({
      tool: "web.search",
      code: "left_to_team",
      message: "Left to researcher",
    });
    expect(llm.requests[1]!.messages.at(-1)?.content).toBe(
      "Not done: web.search is your team's work. Hand it to researcher with delegate_task.",
    );
  });

  it("a specialist keeps its own tools and has no team block", async () => {
    const { llm, run } = setup([{ text: "Done." }], {
      profile: { ...chief, role: "specialist" },
    });
    await run();
    const request = llm.requests[0]!;
    expect(request.messages[0]?.content).not.toContain("You coordinate a team.");
    expect(request.tools?.map((t) => t.name)).toContain("web.search");
  });

  it("a group's leader coordinates there, whatever its role", async () => {
    const { llm, run } = setup([{ text: "On it." }], {
      profile: { ...chief, role: "specialist" },
      leads: true,
    });
    await run();
    expect(llm.requests[0]!.messages[0]?.content).toContain("You coordinate a team.");
    // A leader routes messages in its group (ADR-0033); in a direct chat a
    // message would answer after it replied, so it isn't offered there.
    expect(llm.requests[0]!.tools?.map((t) => t.name)).toContain("message_agent");
  });
});
