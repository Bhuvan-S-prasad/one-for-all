import {
  asId,
  type AgentId,
  type AgentProfile,
  type ChildRunRequest,
  type DiscussionPlan,
  type LLMRequest,
  type MessageId,
  type TenantContext,
  type ThreadId,
  type ToolDescriptor,
  type UserId,
  type WorkspaceId,
} from "@ofa/core";
import { describe, expect, it } from "vitest";
import {
  createFakeToolExecutor,
  createMemoryDiscussions,
  createMemoryRuntime,
  createMemoStepRunner,
  createScriptedLLM,
  okOutcome,
  runAgent,
  runDiscussion,
  type ScriptedReply,
} from "./index";

// Group discussions (ADR-0050): turns one at a time in a fixed order, each
// reading the ones before it; passes end the rounds early; a stop ends it;
// the coordinator closes; a turn can't bring in another agent.

const tenant: TenantContext = {
  workspaceId: asId<WorkspaceId>("ws_1"),
  userId: asId<UserId>("usr_1"),
};
const threadId = asId<ThreadId>("thread_1");
const QUESTION = "Which database should we pick for the new service, and why?";

const profile = (slug: string, name: string, role?: "coordinator"): AgentProfile => ({
  id: asId<AgentId>(slug),
  slug,
  name,
  description: "",
  status: "active",
  job: `${name}'s job`,
  ...(role ? { role } : {}),
  modelTier: "standard",
  autonomy: "act-with-approval",
  voice: "brief",
  memoryScopes: [],
  budgets: { steps: 20, tokens: 100_000 },
  grants: [],
});

const chief = profile("chief", "Chief", "coordinator");
const ana = profile("ana", "Ana");
const ben = profile("ben", "Ben");
const cy = profile("cy", "Cy");

const descriptor = (name: string): ToolDescriptor => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  annotations: { readOnly: name === "web.search" },
  source: "builtin",
});

/** Each agent's replies in order; a function sees the request. */
function setup(
  replies: Record<string, ScriptedReply[]>,
  options: { rounds?: number; tainted?: boolean; webTaints?: boolean } = {},
) {
  const runtime = createMemoryRuntime();
  for (const p of [chief, ana, ben, cy]) runtime.agents.profiles.set(p.id, p);
  runtime.threads.messages.set(threadId, [
    {
      id: asId<MessageId>("q1"),
      author: "user",
      agentId: null,
      content: `@all ${QUESTION}`,
      createdAt: new Date(),
    },
  ]);
  const plan: DiscussionPlan = {
    id: "d1",
    threadId,
    questionMessageId: asId<MessageId>("q1"),
    coordinator: { id: chief.id, name: chief.name },
    members: [ana, ben, cy].map((p) => ({ id: p.id, name: p.name })),
    rounds: options.rounds ?? 2,
    status: "active",
    tainted: options.tainted ?? false,
  };
  const discussions = createMemoryDiscussions(runtime, [plan]);
  const tools = createFakeToolExecutor([
    {
      descriptor: descriptor("web.search"),
      run: () => okOutcome("[results]", options.webTaints ?? false),
    },
    { descriptor: descriptor("message_agent"), run: () => okOutcome("Sent.") },
    { descriptor: descriptor("delegate_task"), run: () => okOutcome("Handing over.") },
    { descriptor: descriptor("ask_group"), run: () => okOutcome("Asked.") },
  ]);
  // One scripted model per agent, so each turn reads its own replies.
  const llms = new Map(Object.entries(replies).map(([k, v]) => [k, createScriptedLLM([...v])]));
  const order: string[] = [];
  const requests: { agent: string; request: LLMRequest }[] = [];
  const onInvoke = async (_id: string, child: ChildRunRequest) => {
    order.push(child.agentId);
    const llm = llms.get(child.agentId)!;
    const before = llm.requests.length;
    // Like Inngest's step.invoke: a run that fails after its retries comes back as null.
    const result = await runAgent(
      {
        ctx: { ...tenant, agentId: child.agentId, runId: child.runId },
        threadId: child.threadId,
        trigger: "discussion",
        requestId: child.messageId,
        ...(child.discussion ? { discussion: child.discussion } : {}),
      },
      { llm, tools, runs: runtime.runs, agents: runtime.agents, threads: runtime.threads },
      createMemoStepRunner(),
    ).catch(() => null);
    if (!result) return null;
    for (const request of llm.requests.slice(before)) {
      requests.push({ agent: child.agentId, request });
    }
    return {
      status: result.status,
      stopReason: result.stopReason,
      reply: result.reply,
      tainted: result.tainted,
      messageId: result.messageId,
      ...(result.passed ? { passed: true } : {}),
    };
  };
  const steps = createMemoStepRunner({ onInvoke });
  const run = () => runDiscussion({ ctx: tenant, discussionId: "d1" }, { discussions }, steps);
  return { runtime, discussions, order, requests, run, steps, tools };
}

const say = (text: string): ScriptedReply => ({ text });
const thread = (runtime: ReturnType<typeof createMemoryRuntime>) =>
  runtime.threads.messages.get(threadId)!;

describe("runDiscussion", () => {
  it("takes turns in order, each reading the turns before it, and the coordinator closes", async () => {
    const t = setup({
      ana: [say("Postgres: we know it."), say("NOTHING_TO_ADD")],
      ben: [say("Agree with Ana; pgvector covers search."), say("NOTHING_TO_ADD")],
      cy: [say("SQLite is lighter, but Ana is right for teams."), say("NOTHING_TO_ADD")],
      chief: [say("Postgres. Ana: familiarity; Ben: pgvector; Cy: SQLite only for one person.")],
    });
    const result = await t.run();

    // Round 1 in order, round 2 where everyone passed, then the close.
    expect(t.order).toEqual(["ana", "ben", "cy", "ana", "ben", "cy", "chief"]);
    expect(result).toMatchObject({ status: "done", turns: 6, rounds: 2 });
    const posted = thread(t.runtime).filter((m) => m.author === "agent");
    // Passes post nothing: three answers and the close.
    expect(posted.map((m) => m.agentId)).toEqual(["ana", "ben", "cy", "chief"]);
    expect(result.closingMessageId).toBe(posted.at(-1)!.id);
    expect(t.discussions.plans.get("d1")).toMatchObject({
      status: "done",
      closingMessageId: posted.at(-1)!.id,
    });

    // Ben's first turn sees Ana's answer, by name, and the turn instructions last.
    const ben1 = t.requests.find((r) => r.agent === "ben")!.request.messages;
    expect(ben1.some((m) => m.role === "user" && m.content.includes("[Ana] Postgres"))).toBe(true);
    const last = ben1.at(-1)!;
    expect(last.content).toContain("Taking part, in this order: Ana, Ben and Cy");
    expect(last.content).toContain("round 1 of 2, and you are number 2");
    expect(last.content).toContain(QUESTION);
    expect(last.content).not.toContain("NOTHING_TO_ADD");
    // From round 2 a member may pass.
    const ana2 = t.requests.filter((r) => r.agent === "ana")[1]!.request.messages.at(-1)!;
    expect(ana2.content).toContain("NOTHING_TO_ADD");
    // The close reads every turn and is asked to credit each member.
    const close = t.requests.find((r) => r.agent === "chief")!.request;
    expect(close.messages.at(-1)!.content).toContain("Leave nobody who spoke out");
    expect(close.promptVersion).toContain("harness.discussion_close@1");
  });

  it("stops after the last round even if members keep talking", async () => {
    const t = setup(
      {
        ana: [say("A1")],
        ben: [say("B1")],
        cy: [say("C1")],
        chief: [say("Closed.")],
      },
      { rounds: 1 },
    );
    const result = await t.run();
    expect(t.order).toEqual(["ana", "ben", "cy", "chief"]);
    expect(result).toMatchObject({ status: "done", turns: 3, rounds: 1 });
  });

  it("gives a turn no way to bring in another agent, and a short step budget", async () => {
    const t = setup(
      {
        ana: [
          (request) => {
            const names = (request.tools ?? []).map((tool) => tool.name);
            expect(names).toContain("web.search");
            expect(names).not.toContain("message_agent");
            expect(names).not.toContain("delegate_task");
            expect(names).not.toContain("ask_group");
            return { text: "", toolCalls: [{ id: "s1", name: "web.search", args: { q: 1 } }] };
          },
          // Searching every step: the turn stops at 8 steps, not the agent's 20.
          ...Array.from({ length: 12 }, (_, n) => ({
            toolCalls: [{ name: "web.search", args: { q: n + 2 } }],
          })),
          say("What I found."),
        ],
        ben: [say("B1")],
        cy: [say("C1")],
        chief: [say("Closed.")],
      },
      { rounds: 1 },
    );
    await t.run();
    const anaRun = t.discussions.turns.find((turn) => turn.agentId === "ana")!.runId;
    const models = t.runtime.runs.events.filter(
      (e) => e.runId === anaRun && e.type === "model.called",
    );
    // Eight steps, plus the last call that answers with what it has.
    expect(models).toHaveLength(9);
  });

  it("ends at once when the discussion is stopped between turns", async () => {
    const t = setup({
      ana: [say("A1")],
      ben: [say("B1")],
      cy: [say("C1")],
      chief: [say("Closed.")],
    });
    // The person says stop while Ana is answering.
    const realStart = t.discussions.startTurn.bind(t.discussions);
    t.discussions.startTurn = async (ctx, id, turn) => {
      if (turn.agentId === "ben") await t.discussions.update(ctx, id, { status: "stopped" });
      return realStart(ctx, id, turn);
    };
    const result = await t.run();
    expect(t.order).toEqual(["ana"]);
    expect(result.status).toBe("stopped");
    expect(t.discussions.plans.get("d1")!.status).toBe("stopped");
  });

  it("taints every later turn after one reads outside content", async () => {
    const t = setup(
      {
        ana: [{ toolCalls: [{ name: "web.search", args: { q: "db" } }] }, say("From the web: A")],
        ben: [say("B1")],
        cy: [say("C1")],
        chief: [say("Closed.")],
      },
      { rounds: 1, webTaints: true },
    );
    await t.run();
    expect(t.discussions.plans.get("d1")!.tainted).toBe(true);
    const tainted = t.discussions.turns.map((turn) => [
      turn.agentId,
      t.runtime.runs.records.get(turn.runId)!.tainted,
    ]);
    expect(tainted).toEqual([
      ["ana", true],
      ["ben", true],
      ["cy", true],
      ["chief", true],
    ]);
  });

  it("makes no second run or message when it is replayed", async () => {
    const t = setup(
      { ana: [say("A1")], ben: [say("B1")], cy: [say("C1")], chief: [say("Closed.")] },
      { rounds: 1 },
    );
    await t.run();
    const before = thread(t.runtime).length;
    await t.run();
    expect(t.order).toHaveLength(4);
    expect(t.discussions.turns).toHaveLength(4);
    expect(thread(t.runtime)).toHaveLength(before);
  });

  it("skips a member whose turn failed, and fails when the close does, keeping the turns", async () => {
    // Ben's and the coordinator's models have no reply: their runs fail.
    const t = setup({ ana: [say("A1")], ben: [], cy: [say("C1")], chief: [] }, { rounds: 1 });
    const result = await t.run();
    expect(t.order).toEqual(["ana", "ben", "cy", "chief"]);
    expect(result.status).toBe("failed");
    expect(t.discussions.plans.get("d1")!.status).toBe("failed");
    expect(thread(t.runtime).filter((m) => m.author === "agent")).toHaveLength(2);
  });
});
