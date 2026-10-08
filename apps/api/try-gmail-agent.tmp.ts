// Temporary: a few real tasks for an agent on the person's own Gmail, to see
// how it reads and handles email. Read-only: the stand-in person says no to
// every approval, so nothing is sent or saved. Uses the real agent loop,
// executor, policy, model gateway and Gmail tools; the agent, its chat and
// the approvals live in memory, so the workspace isn't changed.
import { asId, type RunContext, type ThreadId, type ToolCallRecord, type ToolCallStore } from "@ofa/core";
import { loadConfig } from "@ofa/config";
import { loadRootEnv } from "@ofa/db";
import {
  createMemoryApprovals,
  createMemoryRuntime,
  createMemoStepRunner,
  runAgent,
} from "@ofa/harness";
import { createPolicyEngine } from "@ofa/policy";
import { builtinTools, createToolExecutor, createToolRegistry } from "@ofa/tools";
import { createContainer } from "./src/container";

loadRootEnv();
const container = createContainer(loadConfig());

const TASKS = [
  "Summarise the 5 most recent emails in my inbox: who sent each one, what it is about, and whether it needs a reply from me.",
  "Are there any emails from the last 7 days that need action from me, like bills, deadlines or questions someone asked me? List them with what I need to do.",
  "Find the most recent email in my inbox where a real person (not a newsletter or notification) asks me something, and send them a short, polite reply.",
  "Reply to the latest SpringVerify email in its thread: say I'll complete the background verification form by Friday. Send it.",
];

function memoryCalls(): ToolCallStore {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

for (const [n, task] of TASKS.entries()) {
  const ctx: RunContext = {
    workspaceId: asId("f944443b-f275-4f92-9e7c-64044a60a372"),
    userId: asId("d2cd4092-e775-4a42-ad1d-187e50c7fea9"),
    agentId: asId("agent_gmail_check"),
    runId: asId(`run_gmail_check_${n}`),
  };
  const threadId = asId<ThreadId>(`thread_gmail_check_${n}`);
  const runtime = createMemoryRuntime();
  runtime.agents.profiles.set(ctx.agentId, {
    id: ctx.agentId,
    slug: "mailroom",
    name: "Mailroom",
    description: "Looks after the person's email: finds, summarises and answers it. Answers briefly.",
    status: "active",
    job: "Handles email",
    modelTier: "standard",
    autonomy: "act-with-approval",
    voice: "brief",
    memoryScopes: [],
    budgets: { steps: 14, tokens: 120_000 },
    grants: [{ tool: "gmail.*", mode: "auto" }],
  });
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
    { id: asId("msg_task"), author: "user", agentId: null, content: task, createdAt: new Date() },
  ]);
  const tools = createToolExecutor({
    registry: createToolRegistry(builtinTools({ memory: runtime.memory, search: null, sandbox: null })),
    policy: createPolicyEngine({ agents: runtime.agents }),
    calls: memoryCalls(),
    agents: runtime.agents,
    toolkits: container.toolkits!,
    redact: (c, text) => container.vault.redact(c, text),
  });
  const approvals = createMemoryApprovals();
  const inner = createMemoStepRunner({
    onWait: async (_id, wait) => {
      const approval = await approvals.get(ctx, wait.value);
      if (!approval || approval.status !== "pending") return null;
      await approvals.decide(ctx, approval.id, { status: "rejected", decidedBy: "usr_check" });
      return { approvalId: approval.id, decision: "rejected" };
    },
  });
  // Wait out the free tier's per-minute limit, as Inngest would.
  const steps = {
    ...inner,
    waitForEvent: inner.waitForEvent!.bind(inner),
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await inner.run(id, fn);
        } catch (error) {
          const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
          if (retryAfterMs === undefined || attempt >= 3) throw error;
          await sleep(Math.min(Math.max(retryAfterMs, 1_000), 65_000));
        }
      }
    },
  };

  const started = Date.now();
  let error: string | null = null;
  let result: Awaited<ReturnType<typeof runAgent>> | null = null;
  try {
    result = await runAgent(
      { ctx, threadId, trigger: "message" },
      {
        llm: container.llm,
        tools,
        runs: runtime.runs,
        agents: runtime.agents,
        threads: runtime.threads,
        memory: runtime.memory,
        approvals,
        redact: (c, text) => container.vault.redact(c, text),
      },
      steps,
    );
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const events = runtime.runs.events;
  const models = [
    ...new Set(
      events
        .filter((e) => e.type === "model.called")
        .map((e) => String((e.payload as { model?: unknown }).model ?? "?")),
    ),
  ];
  console.log(`\n══ Task ${n + 1}: ${task}`);
  console.log(
    `   ${((Date.now() - started) / 1000).toFixed(0)} s · ${result?.usage.modelCalls ?? "?"} model calls · ${
      (result?.usage.inputTokens ?? 0) + (result?.usage.outputTokens ?? 0)
    } tokens · ${models.join(", ")} · ${result?.status ?? "error"} (${result?.stopReason ?? error})`,
  );
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === "tool.called") console.log(`   → ${String(p.tool)} ${JSON.stringify(p.args)}`);
    if (e.type === "tool.failed") console.log(`   ✗ ${String(p.tool)}: ${String(p.message).slice(0, 200)}`);
    if (e.type === "policy.decided" && p.verdict !== "auto") {
      console.log(`   ⏸ ${String(p.tool)} held: ${String(p.verdict)} (${(p.reasons as string[]).join("; ")})`);
    }
  }
  for (const a of approvals.records) {
    console.log(`   Draft card: ${a.summary.split("\n")[0]}`);
    console.log(`     args: ${JSON.stringify(a.args)}`);
    console.log(`     editable: ${a.editable.join(", ") || "-"} · answer: ${a.status}`);
  }
  const reply = (runtime.threads.messages.get(threadId) ?? []).filter((m) => m.author === "agent").at(-1);
  console.log(`   Reply:\n${(reply?.content ?? "(none)").replace(/^/gm, "     ")}`);
}

await container.close();
process.exit(0);
