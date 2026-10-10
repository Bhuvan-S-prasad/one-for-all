import {
  asId,
  type AgentProfile,
  type MessageId,
  type RunContext,
  type ThreadId,
  type ToolDescriptor,
} from "@ofa/core";
import { describe, expect, it } from "vitest";
import {
  createFakeToolExecutor,
  createMemoryRuntime,
  createMemoStepRunner,
  createScriptedLLM,
  okOutcome,
  runAgent,
  type RunInput,
  type ScriptedReply,
} from "./index";

// Steering (M5.05), and runs on the clock: routines (M5.06) and tasks an
// agent set for later (M5.07).

const ctx: RunContext = {
  workspaceId: asId("ws_1"),
  userId: asId("usr_1"),
  agentId: asId("scout"),
  runId: asId("run_1"),
};
const threadId = asId<ThreadId>("thread_1");

const profile: AgentProfile = {
  id: asId("scout"),
  slug: "scout",
  name: "Scout",
  description: "",
  status: "active",
  job: "Research",
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: ["agent"],
  budgets: { steps: 10, tokens: 100_000 },
  grants: [{ tool: "web.search", mode: "auto" }],
};

const search: ToolDescriptor = {
  name: "web.search",
  description: "Search",
  inputSchema: { type: "object" },
  annotations: { readOnly: true },
  source: "builtin",
};

function setup(
  script: ScriptedReply[],
  options: {
    trigger?: RunInput["trigger"];
    requestId?: string;
    messages?: { id: string; author: "user" | "agent" | "system"; content: string }[];
    followUps?: { id: string; content: string }[][];
  } = {},
) {
  const runtime = createMemoryRuntime();
  runtime.agents.profiles.set(ctx.agentId, profile);
  runtime.runs.records.set(ctx.runId, {
    id: ctx.runId,
    agentId: ctx.agentId,
    threadId,
    trigger: options.trigger ?? "message",
    status: "queued",
    tainted: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
  });
  runtime.threads.messages.set(
    threadId,
    (
      options.messages ?? [{ id: "m1", author: "user", content: "Find the latest on pgvector." }]
    ).map((m) => ({ ...m, id: asId<MessageId>(m.id), agentId: null, createdAt: new Date() })),
  );
  const claims: string[] = [];
  const queue = [...(options.followUps ?? [])];
  const runs = {
    ...runtime.runs,
    async claimFollowUps(_ctx: RunContext, thread: ThreadId) {
      claims.push(thread);
      return (queue.shift() ?? []).map((m) => ({ id: asId<MessageId>(m.id), content: m.content }));
    },
  };
  const llm = createScriptedLLM(script);
  const tools = createFakeToolExecutor([
    { descriptor: search, run: () => okOutcome("pgvector 0.9 is out.") },
  ]);
  const deps = { llm, tools, runs, agents: runtime.agents, threads: runtime.threads };
  const run = () =>
    runAgent(
      {
        ctx,
        threadId,
        trigger: options.trigger ?? "message",
        ...(options.requestId ? { requestId: options.requestId } : {}),
      },
      deps,
      createMemoStepRunner(),
    );
  return { runtime, runs, llm, run, claims };
}

const userTexts = (llm: ReturnType<typeof createScriptedLLM>, call: number) =>
  (llm.requests[call]?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content);

describe("steering (M5.05)", () => {
  it("reads what the person added at the next step boundary", async () => {
    const { runtime, llm, run, claims } = setup(
      [
        { toolCalls: [{ name: "web.search", args: { query: "pgvector" } }] },
        { text: "pgvector 0.9 is out, and so is the HNSW change you asked about." },
      ],
      { followUps: [[], [{ id: "m2", content: "Also check the HNSW changes." }]] },
    );
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(claims).toEqual([threadId, threadId]);
    // Not in the first call; in the second, after the tool result.
    expect(userTexts(llm, 0).join()).not.toContain("HNSW");
    const second = userTexts(llm, 1);
    expect(second.at(-1)).toContain("While you were working, the person added this");
    expect(second.at(-1)).toContain("Also check the HNSW changes.");
    expect(llm.requests[1]?.messages.at(-1)?.role).toBe("user");
    // The task block restates it too, and the prompt records the template.
    expect(llm.requests[1]?.messages[0]?.content).toContain("Then: Also check the HNSW changes.");
    expect(llm.requests[1]?.promptVersion).toContain("harness.steering@1");
    const steered = runtime.runs.events.find((e) => e.type === "run.steered");
    expect(steered?.payload).toMatchObject({ messageIds: ["m2"] });
  });

  it("doesn't repeat a follow-up the run already read as history", async () => {
    const { llm, run, runtime } = setup([{ text: "Done." }], {
      messages: [
        { id: "m1", author: "user", content: "Find the latest on pgvector." },
        { id: "m2", author: "user", content: "And keep it short." },
      ],
      followUps: [[{ id: "m2", content: "And keep it short." }]],
    });
    await run();
    expect(userTexts(llm, 0).filter((t) => t.includes("keep it short"))).toHaveLength(1);
    expect(runtime.runs.events.some((e) => e.type === "run.steered")).toBe(true);
  });

  it("skips a run whose message another run took as steering while it started", async () => {
    const { runtime, runs, llm, run } = setup([{ text: "never" }]);
    const update = runs.update.bind(runs);
    runs.update = async (c, id, patch) => {
      await update(c, id, patch);
      // The working run claimed this one's message between its read and its update.
      if (patch.status === "running") {
        runtime.runs.records.set(id, { ...runtime.runs.records.get(id)!, status: "cancelled" });
      }
    };
    const result = await run();
    expect(result.status).toBe("skipped");
    expect(llm.requests).toHaveLength(0);
  });
});

describe("runs on the clock (M5.06–07)", () => {
  it("reads a routine's note as its request, and doesn't learn from it", async () => {
    const { llm, run } = setup([{ text: "Here is this morning's brief." }], {
      trigger: "routine",
      requestId: "r1",
      messages: [{ id: "r1", author: "system", content: "Routine “Morning”: Summarise the news." }],
    });
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(result.learn).toBe(false);
    const asked = userTexts(llm, 0).at(-1)!;
    expect(asked).toContain("It is time for one of your routines");
    expect(asked).toContain("Routine “Morning”: Summarise the news.");
    expect(llm.requests[0]?.promptVersion).toContain("harness.routine@1");
  });

  it("reads a scheduled task as its request", async () => {
    const { llm, run } = setup([{ text: "Checked: the page changed." }], {
      trigger: "schedule",
      requestId: "s1",
      messages: [
        { id: "m1", author: "user", content: "Check the pricing page at five." },
        { id: "s1", author: "system", content: "Scheduled task: Check the pricing page." },
      ],
    });
    const result = await run();
    expect(result.learn).toBe(false);
    expect(userTexts(llm, 0).at(-1)).toContain("Earlier in this conversation you scheduled");
    expect(llm.requests[0]?.promptVersion).toContain("harness.scheduled_task@1");
    expect(llm.requests[0]?.promptVersion).not.toContain("harness.routine@1");
  });

  it("keeps other notes out of the model's view", async () => {
    const { llm, run } = setup([{ text: "Hi." }], {
      messages: [
        { id: "n1", author: "system", content: "Routine “Morning”: Summarise the news." },
        { id: "m1", author: "user", content: "Hello" },
      ],
    });
    await run();
    expect(userTexts(llm, 0).join()).not.toContain("Summarise the news");
  });
});
