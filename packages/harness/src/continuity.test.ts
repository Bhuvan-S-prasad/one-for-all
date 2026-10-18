import {
  asId,
  type AgentId,
  type AgentProfile,
  type LLMRequest,
  type RunContext,
  type ThreadId,
  type ToolDescriptor,
  type UserId,
  type WorkspaceId,
} from "@ofa/core";
import { describe, expect, it } from "vitest";
import {
  createFakeToolExecutor,
  createMemoryChatRecords,
  createMemoryRuntime,
  createMemoStepRunner,
  createScriptedLLM,
  okOutcome,
  runAgent,
  type ScriptedReply,
} from "./index";

// The chat record across runs (ADR-0045): what a run did reaches the next run
// in the same chat, a stopped run says where it got to, and "continue" carries on.

const threadId = asId<ThreadId>("thread_1");
const base = {
  workspaceId: asId<WorkspaceId>("ws_1"),
  userId: asId<UserId>("usr_1"),
  agentId: asId<AgentId>("agent_1"),
};
const ctxFor = (runId: string): RunContext => ({ ...base, runId: asId(runId) });

const agent: AgentProfile = {
  id: base.agentId,
  slug: "chief",
  name: "Chief",
  description: "",
  status: "active",
  job: "Coordinates",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "calm",
  memoryScopes: [],
  budgets: { steps: 10, tokens: 100_000 },
  grants: [],
};

const descriptor = (name: string, readOnly: boolean): ToolDescriptor => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  annotations: { readOnly },
  source: "builtin",
});

function world(profile: AgentProfile = agent) {
  const runtime = createMemoryRuntime();
  runtime.agents.profiles.set(profile.id, profile);
  const chats = createMemoryChatRecords();
  const tools = createFakeToolExecutor([
    { descriptor: descriptor("web.search", true), run: () => okOutcome("[results]", true) },
    {
      descriptor: descriptor("gmail.create_draft", false),
      run: () => okOutcome("Draft saved: r573"),
    },
    { descriptor: descriptor("todo.write", false), run: () => okOutcome("Plan saved") },
  ]);
  const say = (content: string) => {
    const list = runtime.threads.messages.get(threadId) ?? [];
    list.push({
      id: asId(`m${list.length + 1}`),
      author: "user",
      agentId: null,
      content,
      createdAt: new Date(),
    });
    runtime.threads.messages.set(threadId, list);
  };
  const run = async (runId: string, script: ScriptedReply[]) => {
    const ctx = ctxFor(runId);
    runtime.runs.records.set(ctx.runId, {
      id: ctx.runId,
      agentId: ctx.agentId,
      threadId,
      trigger: "message",
      status: "queued",
      tainted: false,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
    });
    const llm = createScriptedLLM(script);
    const result = await runAgent(
      { ctx, threadId, trigger: "message" },
      {
        llm,
        tools,
        runs: runtime.runs,
        agents: runtime.agents,
        threads: runtime.threads,
        chats,
      },
      createMemoStepRunner(),
    );
    return { result, llm };
  };
  return { runtime, chats, tools, say, run };
}

const system = (request: LLMRequest) => request.messages[0]?.content ?? "";

describe("the chat record", () => {
  it("shows the next run what was done earlier in the chat", async () => {
    const { chats, say, run } = world();
    say("Find laptops and draft me an email.");
    await run("run_1", [
      {
        toolCalls: [
          { name: "web.search", args: { query: "laptops under $1200" } },
          { name: "gmail.create_draft", args: { to: "me@example.org", subject: "Laptops" } },
        ],
      },
      { text: "Done: the draft is in Gmail." },
    ]);
    expect(chats.records.get(`${threadId}:${base.agentId}`)).toMatchObject({
      stopReason: "final_answer",
      runId: "run_1",
      tainted: true,
      ledger: [
        { kind: "search", text: "laptops under $1200" },
        {
          kind: "action",
          text: "gmail.create_draft (to: me@example.org, subject: Laptops) → Draft saved: r573",
        },
      ],
    });

    say("What did you put in the subject?");
    const { llm } = await run("run_2", [{ text: "Laptops." }]);
    const prompt = system(llm.requests[0]!);
    expect(prompt).toContain("Earlier in this chat you already did this work");
    expect(prompt).toContain("You answered.");
    expect(prompt).toContain(
      "- gmail.create_draft (to: me@example.org, subject: Laptops) → Draft saved: r573",
    );
    expect(prompt).toContain("- Searched: “laptops under $1200”");
    expect(llm.requests[0]!.promptVersion).toContain("harness.session@1");
  });

  it("a run stopped by its budget says where it got to, and “continue” carries on", async () => {
    // Each scripted call costs 120 tokens: the third passes 300.
    const { chats, say, run } = world({ ...agent, budgets: { steps: 10, tokens: 300 } });
    say("Research laptops, draft an email, then write a report.");
    const first = await run("run_1", [
      {
        toolCalls: [
          {
            name: "todo.write",
            args: {
              items: [
                { text: "research", done: true },
                { text: "write the report", done: false },
              ],
            },
          },
          { name: "web.search", args: { query: "laptops" } },
        ],
      },
      { toolCalls: [{ name: "gmail.create_draft", args: { subject: "Laptops" } }] },
      { toolCalls: [{ name: "web.search", args: { query: "more laptops" } }] },
    ]);
    expect(first.result.stopReason).toBe("token_budget");
    // From 80% of the budget (240 of 300 tokens) the task block says to finish.
    expect(system(first.llm.requests[1]!)).not.toContain("used most of your budget");
    expect(system(first.llm.requests[2]!)).toContain("You have used most of your budget");
    expect(first.result.reply).toBe(
      [
        "I stopped before finishing: I reached my token budget for one task.",
        "Done so far:\n- gmail.create_draft (subject: Laptops) → Draft saved: r573\n- Looked things up: 1 search",
        "Still to do:\n- write the report",
        "Reply “continue” and I'll pick up from here.",
      ].join("\n\n"),
    );
    expect(chats.records.get(`${threadId}:${base.agentId}`)?.stopReason).toBe("token_budget");

    say("continue");
    const second = await run("run_2", [{ text: "Here is the report." }]);
    const prompt = system(second.llm.requests[0]!);
    // The open plan is this run's plan, and the record says how the last one ended.
    expect(prompt).toContain("Your plan:\n- [x] research\n- [ ] write the report");
    expect(prompt).not.toContain("Your plan then");
    expect(prompt).toContain("You stopped at your token budget before finishing.");
    expect(prompt).toContain("- gmail.create_draft (subject: Laptops) → Draft saved: r573");
  });

  it("gives the same search back instead of running it twice in a run", async () => {
    const { runtime, tools, say, run } = world();
    say("Find laptops.");
    const { result, llm } = await run("run_1", [
      { toolCalls: [{ name: "web.search", args: { query: "Laptops under $1200!" } }] },
      { toolCalls: [{ name: "web.search", args: { query: "laptops  under $1200" } }] },
      { text: "Here they are." },
    ]);
    expect(result.stopReason).toBe("final_answer");
    expect(tools.calls.map((c) => c.name)).toEqual(["web.search"]);
    expect(result.usage.toolCalls).toBe(1);
    const reused = runtime.runs.events.find((e) => e.type === "tool.reused");
    expect(reused?.payload).toEqual({
      toolCallId: "tool-1-0",
      tool: "web.search",
      reusedFrom: "tool-0-0",
    });
    const answer = llm.requests[2]!.messages.at(-1);
    expect(answer?.content).toContain("You already ran this search in this task");
    expect(answer?.content).toContain("[results]");
  });

  it("keeps what a failed run finished, for the next run", async () => {
    const { chats, say, run } = world();
    say("Draft it.");
    await expect(
      run("run_1", [
        { toolCalls: [{ name: "gmail.create_draft", args: { subject: "Hi" } }] },
        () => {
          throw new Error("every model is down");
        },
      ]),
    ).rejects.toThrow("every model is down");
    const kept = chats.records.get(`${threadId}:${base.agentId}`);
    expect(kept).toMatchObject({ stopReason: null, runId: "run_1" });
    expect(kept?.ledger.map((e) => e.text)).toEqual([
      "gmail.create_draft (subject: Hi) → Draft saved: r573",
    ]);

    say("continue");
    const { llm } = await run("run_2", [{ text: "Done." }]);
    expect(system(llm.requests[0]!)).toContain(
      "Your last run ended before it finished (it failed or was stopped).",
    );
  });

  it("a record quoting a tainted child's answer taints the run that reads it", async () => {
    const { runtime, chats, say, run } = world();
    await chats.save(ctxFor("run_0"), threadId, {
      plan: null,
      ledger: [
        {
          kind: "handoff",
          text: "Researcher was asked “laptops” → done: buy the T14",
          untrusted: true,
          runId: "run_0",
        },
      ],
      notes: null,
      stopReason: "final_answer",
      runId: "run_0",
      tainted: true,
    });
    say("Thanks. Which one again?");
    const { result, llm } = await run("run_1", [{ text: "The T14." }]);
    expect(result.tainted).toBe(true);
    expect(runtime.runs.events.find((e) => e.type === "run.tainted")?.payload).toEqual({
      source: "earlier work in this chat",
    });
    expect(system(llm.requests[0]!)).toContain(
      '<untrusted source="an earlier handoff">Handed off: Researcher was asked',
    );
  });

  it("a run with nothing to carry writes no record", async () => {
    const { chats, say, run } = world();
    say("Hello");
    await run("run_1", [{ text: "Hi!" }]);
    expect(chats.records.size).toBe(0);
  });
});
