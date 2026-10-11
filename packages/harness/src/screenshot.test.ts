import {
  asId,
  type AgentProfile,
  type LLMImage,
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
  turnMessages,
} from "./index";

// The screenshot fallback (DT.11): a tool result may carry a screenshot,
// which the model sees in a user message after that step's results. Only the
// latest one is ever shown.

const ctx: RunContext = {
  workspaceId: asId("ws_1"),
  userId: asId("usr_1"),
  agentId: asId("agent_1"),
  runId: asId("run_1"),
};
const threadId = asId<ThreadId>("thread_1");
const shot = (n: number): LLMImage => ({ data: `shot-${n}`, mediaType: "image/jpeg" });

describe("turnMessages with a screenshot", () => {
  it("shows the image after all of the step's tool results", () => {
    const messages = turnMessages([
      {
        kind: "assistant",
        text: "",
        toolCalls: [
          { id: "a", name: "desktop.screenshot", args: {} },
          { id: "b", name: "files.list", args: {} },
        ],
      },
      {
        kind: "tool",
        toolCallId: "a",
        toolName: "desktop.screenshot",
        content: "Your desktop now.",
        untrusted: true,
        image: shot(1),
      },
      { kind: "tool", toolCallId: "b", toolName: "files.list", content: "a.txt", untrusted: false },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(messages[3]).toMatchObject({ role: "user", images: [shot(1)] });
    expect(messages[3]?.content).toContain("desktop.screenshot");
  });
});

describe("a run that takes screenshots", () => {
  it("shows the model only the latest screenshot", async () => {
    const screenshot: ToolDescriptor = {
      name: "desktop.screenshot",
      description: "See your desktop",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnly: true },
      source: "builtin",
    };
    const profile: AgentProfile = {
      id: ctx.agentId,
      slug: "desk",
      name: "Desk",
      description: "Uses its desktop.",
      status: "active",
      job: "Desktop work",
      modelTier: "standard",
      autonomy: "act-with-approval",
      voice: "calm",
      memoryScopes: ["agent"],
      budgets: { steps: 10, tokens: 100_000 },
      grants: [{ tool: "desktop.*", mode: "auto" }],
    };
    const runtime = createMemoryRuntime();
    runtime.agents.profiles.set(profile.id, profile);
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
        content: "What is on your screen?",
        createdAt: new Date(),
      },
    ]);
    let taken = 0;
    const tools = createFakeToolExecutor([
      {
        descriptor: screenshot,
        run: () => {
          taken += 1;
          return { ...okOutcome(`Screenshot ${taken}.`, true), image: shot(taken) };
        },
      },
    ]);
    const llm = createScriptedLLM([
      { toolCalls: [{ name: "desktop.screenshot", args: {} }] },
      { toolCalls: [{ name: "desktop.screenshot", args: { again: true } }] },
      { text: "A text editor." },
    ]);
    const result = await runAgent(
      { ctx, threadId, trigger: "message" },
      {
        llm,
        tools,
        runs: runtime.runs,
        agents: runtime.agents,
        threads: runtime.threads,
        memory: runtime.memory,
      },
      createMemoStepRunner(),
    );
    expect(result.stopReason).toBe("final_answer");
    const imagesIn = (n: number) =>
      llm.requests[n]!.messages.flatMap((m) => (m.role === "user" ? (m.images ?? []) : []));
    expect(imagesIn(0)).toEqual([]);
    expect(imagesIn(1)).toEqual([shot(1)]);
    // The second screenshot replaces the first.
    expect(imagesIn(2)).toEqual([shot(2)]);
    // The text of both results stays.
    const toolTexts = llm.requests[2]!.messages.filter((m) => m.role === "tool").map(
      (m) => m.content,
    );
    expect(toolTexts.join("\n")).toContain("Screenshot 1.");
    expect(toolTexts.join("\n")).toContain("Screenshot 2.");
  });
});
