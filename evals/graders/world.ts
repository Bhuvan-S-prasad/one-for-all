import {
  asId,
  findMember,
  type AgentId,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactStore,
  type ChildRunResult,
  type LLMGateway,
  type RunContext,
  type RunId,
  type TeamDirectory,
  type StepRunner,
  type ThreadId,
  type ToolCallRecord,
  type ToolCallStore,
} from "@ofa/core";
import {
  createMemoryApprovals,
  createMemoryChatRecords,
  createMemoryRuntime,
  createMemoStepRunner,
  runAgent,
} from "@ofa/harness";
import { createPolicyEngine } from "@ofa/policy";
import { builtinTools, createToolExecutor, createToolRegistry } from "@ofa/tools";
import { fixtureMailbox } from "../fixtures/mailbox";
import { fixtureBrowser, fixtureComputer } from "../fixtures/site";
import { fixtureFetcher, fixtureSearch } from "../fixtures/web";
import { EVAL_COMPUTER_AGENT, type EvalComputer, type SavedFile } from "./computer";
import type { ChildTranscript, EvalCase, SentFile, Transcript } from "./types";

// One attempt at a case: a fresh, in-memory world around the real harness,
// tool executor and policy engine. Only the model is live; the web comes from
// fixtures and nothing touches the database.

function memoryToolCalls(): ToolCallStore {
  const rows = new Map<string, ToolCallRecord>();
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

/** Artifacts in memory: what the agent sent under its reply. */
function memoryArtifacts(sent: SentFile[]): ArtifactStore {
  const rows = new Map<string, ArtifactRecord>();
  return {
    async put(c, input) {
      const existing = rows.get(input.key);
      if (existing) return existing;
      const size =
        typeof input.content === "string"
          ? new TextEncoder().encode(input.content).length
          : input.content.length;
      const row: ArtifactRecord = {
        id: asId<ArtifactId>(`00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, "0")}`),
        runId: c.runId,
        agentId: c.agentId,
        kind: input.kind,
        name: input.name,
        mimeType: input.mimeType,
        size,
        untrusted: input.untrusted,
        createdAt: new Date(),
      };
      rows.set(input.key, row);
      if (input.kind === "file") sent.push({ name: row.name, mimeType: row.mimeType, size });
      return row;
    },
    get: async (_c, id) => [...rows.values()].find((r) => r.id === id) ?? null,
    read: async () => null,
    open: async () => null,
    listForRun: async (_c, runId) => [...rows.values()].filter((r) => r.runId === runId),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Like Inngest: when the gateway says "try again in N ms" (the free quota for
 * the minute is used up), wait and run the step again.
 */
function patientSteps(inner: StepRunner, wait: (ms: number) => Promise<void>): StepRunner {
  return {
    ...(inner.waitForEvent ? { waitForEvent: inner.waitForEvent.bind(inner) } : {}),
    ...(inner.invokeRun ? { invokeRun: inner.invokeRun.bind(inner) } : {}),
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await inner.run(id, fn);
        } catch (error) {
          const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
          if (retryAfterMs === undefined || attempt >= 3) throw error;
          await wait(Math.min(Math.max(retryAfterMs, 1_000), 65_000));
        }
      }
    },
  };
}

export interface AttemptOptions {
  readonly llm: LLMGateway;
  readonly wait?: (ms: number) => Promise<void>;
  /** The computer for cases that need one (DT.12). */
  readonly computer?: EvalComputer | null;
}

export async function runAttempt(evalCase: EvalCase, options: AttemptOptions): Promise<Transcript> {
  const ctx: RunContext = {
    workspaceId: asId("ws_eval"),
    userId: asId("usr_eval"),
    // On a real computer, the eval agent's own user there.
    agentId: asId(evalCase.computer ? EVAL_COMPUTER_AGENT : "agent_eval"),
    runId: asId("run_eval"),
  };
  const threadId = asId<ThreadId>("thread_eval");
  const runtime = createMemoryRuntime();
  runtime.agents.profiles.set(ctx.agentId, { ...evalCase.agent, id: ctx.agentId });
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
      id: asId("msg_prompt"),
      author: "user",
      agentId: null,
      content: evalCase.prompt,
      createdAt: new Date(),
    },
  ]);

  // The runs the person starts: the first, and a second when the case continues.
  const mainRuns = new Set<string>([ctx.runId]);

  // Teammates (M5.13): profiles by handle, and the handoffs the run makes.
  const teammates = (evalCase.team ?? []).map((t) => ({
    ...t,
    id: asId<AgentId>(`agent_${t.slug}`),
  }));
  for (const t of teammates) runtime.agents.profiles.set(t.id, t);
  const handoffs: {
    runId: string;
    threadId: string;
    agentId: string;
    slug: string;
    brief: string;
  }[] = [];
  const team: TeamDirectory | undefined = teammates.length
    ? {
        // One level deep, as in the app: only the person's runs hand work on.
        // Each teammate with its capability card, as in the app (ADR-0044).
        async members(c) {
          if (!mainRuns.has(c.runId)) return [];
          const cards =
            (await tools.capabilities?.(
              c,
              teammates.map((t) => t.id),
            )) ?? new Map();
          return teammates.map((t) => ({
            id: t.id,
            slug: t.slug,
            name: t.name,
            job: t.job,
            capabilities: cards.get(t.id) ?? [],
          }));
        },
        async handoff(c, input) {
          const member = findMember(await team!.members(c), input.agent);
          if (!member) throw new Error(`There is no agent called ${input.agent} to hand work to.`);
          const n = handoffs.length + 1;
          const runId = `run_child_${n}`;
          const childThread = `thread_child_${n}`;
          runtime.runs.records.set(runId, {
            id: asId(runId),
            agentId: member.id,
            threadId: asId(childThread),
            trigger: "delegation",
            status: "queued",
            tainted: runtime.runs.records.get(c.runId)?.tainted ?? false,
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
          });
          runtime.threads.messages.set(childThread, [
            {
              id: asId(`brief_${n}`),
              author: "agent",
              agentId: c.agentId,
              content: input.brief,
              createdAt: new Date(),
            },
          ]);
          handoffs.push({
            runId,
            threadId: childThread,
            agentId: member.id,
            slug: member.slug,
            brief: input.brief,
          });
          return {
            runId: asId(runId),
            threadId: asId(childThread),
            messageId: asId(`brief_${n}`),
            agentId: member.id,
            agentName: member.name,
          };
        },
        contacts: async () => [],
        message: async () => {
          throw new Error("Messages between agents aren't part of the eval world yet.");
        },
      }
    : undefined;

  const computer = evalCase.computer ? (options.computer ?? null) : null;
  if (evalCase.computer && !computer) {
    throw new Error(`${evalCase.id} needs the sandbox from pnpm infra:up.`);
  }
  let unprepared: string | null = null;
  try {
    await computer?.prepare(ctx, evalCase.computer?.files ?? {});
  } catch (thrown) {
    unprepared = `Couldn't set up the computer: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
  }

  const browser = evalCase.site ? fixtureBrowser(evalCase.site) : null;
  const mailbox = evalCase.mailbox ? fixtureMailbox(evalCase.mailbox) : null;
  const sent: SentFile[] = [];
  const tools = createToolExecutor({
    registry: createToolRegistry([
      ...builtinTools({
        memory: runtime.memory,
        search: fixtureSearch(evalCase.web),
        fetcher: fixtureFetcher(evalCase.web),
        sandbox: computer ? computer.sandbox : browser ? fixtureComputer(browser) : null,
        team: team ?? null,
        vision: async (c) => (await options.llm.modelFor(evalCase.agent.modelTier, c)).vision,
      }),
      ...((mailbox?.tools ?? []) as unknown as ReturnType<typeof builtinTools>),
    ]),
    policy: createPolicyEngine({ agents: runtime.agents }),
    calls: memoryToolCalls(),
    agents: runtime.agents,
    artifacts: memoryArtifacts(sent),
  });

  // The person: answers each request as soon as it is made, like someone
  // watching. Their answer arrives as the event the run waits for.
  const approvals = createMemoryApprovals();
  const person = evalCase.person ?? (() => true);
  const onWait = async (_id: string, wait: { value: string }) => {
    const approval = await approvals.get(ctx, wait.value);
    if (!approval || approval.status !== "pending") return null;
    const status = person(approval) ? "approved" : "rejected";
    await approvals.decide(ctx, approval.id, { status, decidedBy: "usr_eval" });
    return { approvalId: approval.id, decision: status };
  };
  const deps = {
    llm: options.llm,
    tools,
    runs: runtime.runs,
    agents: runtime.agents,
    threads: runtime.threads,
    memory: runtime.memory,
    approvals,
    // Each agent's record per chat (ADR-0045), so a case can continue.
    chats: createMemoryChatRecords(),
    ...(team ? { team } : {}),
    ...(evalCase.harness ? { options: evalCase.harness } : {}),
  };
  const makeSteps = () =>
    createMemoStepRunner({
      onWait,
      // What Inngest's step.invoke does: run the child, from its brief, to the end.
      onInvoke: async (_id, child): Promise<ChildRunResult> => {
        const result = await runAgent(
          {
            ctx: { ...ctx, agentId: child.agentId, runId: child.runId },
            threadId: child.threadId,
            trigger: "delegation",
          },
          deps,
          patientSteps(createMemoStepRunner({ onWait }), options.wait ?? sleep),
        );
        return {
          status: result.status,
          stopReason: result.stopReason,
          reply: result.reply,
          tainted: result.tainted,
        };
      },
    });

  const started = Date.now();
  let result: Transcript["result"] = null;
  let error: string | null = null;
  try {
    if (unprepared) throw new Error(unprepared);
    result = await runAgent(
      { ctx, threadId, trigger: "message" },
      deps,
      patientSteps(makeSteps(), options.wait ?? sleep),
    );
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }

  // The person writes again in the same chat (ADR-0045): a second run there.
  const callsOf = (runId: string) =>
    runtime.runs.events
      .filter((e) => e.runId === runId && e.type === "tool.called")
      .map((e) => ({ name: String(e.payload.tool), args: e.payload.args }));
  const lastReply = () =>
    (runtime.threads.messages.get(threadId) ?? []).filter((m) => m.author === "agent").at(-1)
      ?.content ?? null;
  let underTest: string = ctx.runId;
  let before: Transcript["before"] = null;
  if (evalCase.continueWith && !error) {
    before = {
      reply: lastReply(),
      stopReason: result?.stopReason ?? null,
      toolCalls: callsOf(ctx.runId),
    };
    const next: RunContext = { ...ctx, runId: asId<RunId>("run_eval_2") };
    underTest = next.runId;
    mainRuns.add(next.runId);
    if (evalCase.continueWith.agent) {
      runtime.agents.profiles.set(ctx.agentId, {
        ...evalCase.agent,
        ...evalCase.continueWith.agent,
        id: ctx.agentId,
      });
    }
    runtime.runs.records.set(next.runId, {
      id: next.runId,
      agentId: ctx.agentId,
      threadId,
      trigger: "message",
      status: "queued",
      tainted: false,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, toolCalls: 0 },
    });
    runtime.threads.messages.get(threadId)?.push({
      id: asId("msg_continue"),
      author: "user",
      agentId: null,
      content: evalCase.continueWith.prompt,
      createdAt: new Date(),
    });
    try {
      result = await runAgent(
        { ctx: next, threadId, trigger: "message" },
        deps,
        patientSteps(makeSteps(), options.wait ?? sleep),
      );
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
  }

  let files: SavedFile[] | null = null;
  if (computer && !unprepared) {
    try {
      files = await computer.collect(ctx);
    } catch (thrown) {
      files = [];
      error ??= thrown instanceof Error ? thrown.message : String(thrown);
    }
  }

  // The run under test's own log; each teammate's is in `children`.
  const logOf = (runId: string) =>
    runtime.runs.events
      .filter((e) => e.runId === runId)
      .map((e) => ({ type: e.type, payload: e.payload }));
  const events = logOf(underTest);
  const children: ChildTranscript[] = handoffs.map((h) => ({
    agent: h.slug,
    brief: h.brief,
    reply:
      (runtime.threads.messages.get(h.threadId) ?? [])
        .filter((m) => m.author === "agent" && m.agentId === h.agentId)
        .at(-1)?.content ?? null,
    tainted: runtime.runs.records.get(h.runId)?.tainted ?? false,
    toolCalls: logOf(h.runId)
      .filter((e) => e.type === "tool.called")
      .map((e) => ({ name: String(e.payload.tool), args: e.payload.args })),
  }));
  return {
    reply: lastReply(),
    result,
    error,
    events,
    toolCalls: events
      .filter((e) => e.type === "tool.called")
      .map((e) => ({ name: String(e.payload.tool), args: e.payload.args })),
    memories: [...runtime.memory.records],
    site: browser ? browser.record : null,
    mail: mailbox ? mailbox.record : null,
    files,
    sent,
    approvals: [...approvals.records],
    children,
    before,
    durationMs: Date.now() - started,
  };
}
