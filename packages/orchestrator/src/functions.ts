import {
  EMPTY_RUN_USAGE,
  INNGEST_EVENTS,
  memoryConsolidationRequestedEventSchema,
  messageReceivedEventSchema,
  runCancelledEventSchema,
  runSucceededEventSchema,
  scheduleCreatedEventSchema,
} from "@ofa/contracts";
import {
  asId,
  type ApprovalStore,
  type BlobSweeper,
  type ChildRunRequest,
  type ConsolidationResult,
  type LLMGateway,
  type MemoryMaintenance,
  type ChildRunResult,
  type RoutineRunner,
  type RunContext,
  type RunStart,
  type RunStore,
  type ScheduleRunner,
  type StepRunner,
  type TenantContext,
  type ThreadId,
  type TokenRefresher,
  type TokenRefreshOutcome,
} from "@ofa/core";
import {
  consolidateMemory,
  learnFromRun,
  runAgent,
  runEvent,
  type HarnessDeps,
} from "@ofa/harness";
import { NonRetriableError, RetryAfterError, type Inngest, type InngestFunction } from "inngest";

// Durable functions (ADR-0006). The orchestrator decides when and how often an
// agent runs; what happens inside a run is the harness's job (L3 → L4).

export interface OrchestratorDeps {
  readonly harness: HarnessDeps;
  readonly runs: RunStore;
  /** Open approval requests of a stopped run are expired. */
  readonly approvals?: ApprovalStore;
  /** Keeps idle app sign-ins working (M4.06); absent without the MCP client. */
  readonly tokenRefresh?: TokenRefresher;
  /** Starts routines when they are due (M5.06). */
  readonly routines?: RoutineRunner;
  /** Fires tasks and reminders agents set for later (M5.07). */
  readonly schedules?: ScheduleRunner;
  /** Nightly memory consolidation (M5.09). */
  readonly memory?: MemoryMaintenance;
  /** Removes blobs no artifact points at any more (ADR-0047); absent without an object store. */
  readonly blobSweep?: BlobSweeper;
}

/** Hourly, away from the other hourly work. */
export const BLOB_SWEEP_CRON = "45 * * * *";

/** Hourly: each workspace is consolidated when it is 3 at night there. */
export const MEMORY_CONSOLIDATION_CRON = "15 * * * *";

/** How often due routines are looked for: every minute. */
export const ROUTINE_TICK_CRON = "* * * * *";

/** A run started on the clock, as the event that starts it. */
function startEvent(run: RunStart) {
  return {
    name: INNGEST_EVENTS.messageReceived,
    id: `message-received-${run.runId}`,
    data: messageReceivedEventSchema.parse(run),
  };
}

/** How often sign-ins are checked, and how far ahead of expiry they are refreshed. */
export const TOKEN_REFRESH_CRON = "*/10 * * * *";
export const TOKEN_REFRESH_AHEAD_MS = 15 * 60_000;

/** Errors that waiting will not fix: a missing key, a malformed request. */
const NOT_RETRYABLE = new Set(["auth", "bad_request", "context_length"]);

/**
 * Starts a child run and waits for what it returns (Inngest `step.invoke` on
 * the `agent-run` function); throws if it failed or ran out of time.
 */
export type InvokeChildRun = (
  id: string,
  child: ChildRunRequest,
  timeoutMs: number,
) => Promise<unknown>;

/**
 * Adapt Inngest's `step.run` to the harness's `StepRunner`, and turn model
 * errors into Inngest's retry signals: wait for capacity, or stop retrying.
 * With `invoke`, runs can hand work to other agents (M5.01).
 */
export function inngestSteps(
  step: {
    run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
    waitForEvent?: (
      id: string,
      opts: { event: string; timeout: number; if: string },
    ) => Promise<{ data?: unknown } | null>;
  },
  invoke?: InvokeChildRun,
): StepRunner {
  const waitForEvent = step.waitForEvent?.bind(step);
  return {
    ...(invoke
      ? {
          async invokeRun(id, child, { timeoutMs }) {
            try {
              const result = (await invoke(id, child, Math.max(1_000, timeoutMs))) as {
                status?: ChildRunResult["status"];
                stopReason?: string | null;
                reply?: string | null;
                tainted?: boolean;
              } | null;
              if (!result?.status) return null;
              return {
                status: result.status,
                stopReason: result.stopReason ?? null,
                reply: result.reply ?? null,
                // Not knowing is treated as having read outside content.
                tainted: result.tainted ?? true,
              };
            } catch {
              // The child failed after its retries, or ran past the timeout;
              // its own run says why.
              return null;
            }
          },
        }
      : {}),
    ...(waitForEvent
      ? {
          async waitForEvent(id, { event, field, value, timeoutMs }) {
            // Values are our own IDs; refuse anything that could break out of the expression.
            if (!/^[\w-]+$/.test(field) || !/^[\w-]+$/.test(value)) {
              throw new Error(`Unsafe wait match: ${field}=${value}`);
            }
            const found = await waitForEvent(id, {
              event,
              timeout: Math.max(1_000, timeoutMs),
              if: `async.data.${field} == '${value}'`,
            });
            return found ? ((found.data ?? {}) as Record<string, unknown>) : null;
          },
        }
      : {}),
    async run<T>(id: string, fn: () => Promise<T>): Promise<T> {
      const result = await step.run(id, async () => {
        try {
          return await fn();
        } catch (error) {
          const modelCode = (error as { modelCode?: string }).modelCode;
          const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
          const message = error instanceof Error ? error.message : String(error);
          if (retryAfterMs !== undefined) {
            throw new RetryAfterError(message, Math.max(1_000, retryAfterMs), { cause: error });
          }
          if (modelCode && NOT_RETRYABLE.has(modelCode)) {
            throw new NonRetriableError(message, { cause: error });
          }
          throw error;
        }
      });
      return result as T;
    },
  };
}

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/API key/i.test(message)) {
    return "I can't reach my model: the API key is missing or was refused. Add it in Settings, then ask again.";
  }
  if (/capacity|rate/i.test(message)) {
    return "I couldn't get a turn with the model: free capacity is used up for now. Try again in a while.";
  }
  return "Something went wrong and I couldn't finish. The details are in Activity.";
}

export function createFunctions(inngest: Inngest.Any, deps: OrchestratorDeps) {
  // A handoff's child is another `agent-run` (M5.01). The function invokes
  // itself, so it is reached through this holder rather than by name.
  const self: { agentRun?: InngestFunction.Any } = {};

  const agentRun = inngest.createFunction(
    {
      id: "agent-run",
      name: "Agent run",
      triggers: [{ event: INNGEST_EVENTS.messageReceived }],
      // One run at a time per agent; more messages wait their turn.
      concurrency: [{ key: "event.data.agentId", limit: 1 }],
      // A person's message outranks queued background work (§6.3, M5.05):
      // it starts up to ten minutes ahead of routines and scheduled tasks.
      priority: { run: "event.data.trigger == 'message' ? 600 : 0" },
      // Stop pressed: cancel at the next step boundary. Finished steps stay done.
      cancelOn: [
        { event: INNGEST_EVENTS.runCancelled, if: "async.data.runId == event.data.runId" },
      ],
      retries: 4,
      onFailure: async ({ event, error, step }) => {
        const data = messageReceivedEventSchema.parse(event.data.event.data);
        const ctx: RunContext = {
          workspaceId: asId(data.workspaceId),
          userId: asId(data.userId),
          agentId: asId(data.agentId),
          runId: asId(data.runId),
        };
        await step.run("mark-failed", async () => {
          const message = (error.message || "Run failed").slice(0, 2_000);
          const run = await deps.runs.get(ctx, ctx.runId);
          await deps.approvals?.expireForRun(ctx, ctx.runId);
          await deps.runs.update(ctx, ctx.runId, {
            status: "failed",
            error: { code: "run_failed", message },
            endedAt: new Date(),
            onlyIfActive: true,
          });
          await deps.runs.append(ctx, ctx.runId, [
            runEvent("end-failed", "run.ended", {
              status: "failed",
              stopReason: "error",
              usage: run?.usage ?? EMPTY_RUN_USAGE,
              error: { code: "run_failed", message },
            }),
          ]);
          await deps.harness.threads.addAgentMessage(ctx, {
            threadId: asId<ThreadId>(data.threadId),
            content: failureText(error),
          });
        });
      },
    },
    async ({ event, step }) => {
      const data = messageReceivedEventSchema.parse(event.data);
      const ctx: RunContext = {
        workspaceId: asId(data.workspaceId),
        userId: asId(data.userId),
        agentId: asId(data.agentId),
        runId: asId(data.runId),
      };
      const invoke: InvokeChildRun = (id, child, timeoutMs) =>
        step.invoke(id, {
          function: self.agentRun!,
          data: messageReceivedEventSchema.parse({
            workspaceId: data.workspaceId,
            userId: data.userId,
            agentId: child.agentId,
            threadId: child.threadId,
            messageId: child.messageId,
            runId: child.runId,
            trigger: "delegation",
          }),
          timeout: timeoutMs,
        });
      const result = await runAgent(
        {
          ctx,
          threadId: asId<ThreadId>(data.threadId),
          trigger: data.trigger,
          requestId: data.messageId,
        },
        deps.harness,
        inngestSteps(step, invoke),
      );
      if (result.learn && result.messageId) {
        // Learning runs as its own function, so this agent's next message
        // does not wait behind a slow extraction call.
        await step.sendEvent("learn", {
          name: INNGEST_EVENTS.runSucceeded,
          id: `run-succeeded-${data.runId}`,
          data: runSucceededEventSchema.parse({
            workspaceId: data.workspaceId,
            userId: data.userId,
            agentId: data.agentId,
            runId: data.runId,
            threadId: data.threadId,
            messageId: result.messageId,
          }),
        });
      }
      return result;
    },
  );
  self.agentRun = agentRun;

  // Memory extraction after an answered run (ARCHITECTURE.md §8). Learning is
  // a bonus: a failure here is logged by Inngest and never reaches the person.
  const agentLearn = inngest.createFunction(
    {
      id: "agent-learn",
      name: "Agent learns from a run",
      triggers: [{ event: INNGEST_EVENTS.runSucceeded }],
      // One at a time per workspace, so learning never crowds out answers.
      concurrency: [{ key: "event.data.workspaceId", limit: 1 }],
      retries: 2,
    },
    async ({ event, step }) => {
      const data = runSucceededEventSchema.parse(event.data);
      const ctx: RunContext = {
        workspaceId: asId(data.workspaceId),
        userId: asId(data.userId),
        agentId: asId(data.agentId),
        runId: asId(data.runId),
      };
      return learnFromRun(
        { ctx, threadId: asId<ThreadId>(data.threadId), messageId: asId(data.messageId) },
        deps.harness,
        inngestSteps(step),
      );
    },
  );

  // Inngest's own "function cancelled" event does not carry our run ID, so the
  // stop event itself also triggers this bookkeeping.
  const agentRunCancelled = inngest.createFunction(
    {
      id: "agent-run-cancelled",
      name: "Agent run cancelled",
      triggers: [{ event: INNGEST_EVENTS.runCancelled }],
    },
    async ({ event, step }) => {
      const data = runCancelledEventSchema.parse(event.data);
      const ctx: TenantContext = { workspaceId: asId(data.workspaceId), userId: asId(data.userId) };
      // Work it handed to other agents stops too (M5.01); each child stops
      // its own children the same way.
      const children = await step.run(
        "find-children",
        async () => (await deps.runs.activeChildren?.(ctx, asId(data.runId))) ?? [],
      );
      if (children.length > 0) {
        await step.sendEvent(
          "cancel-children",
          children.map((childId) => ({
            name: INNGEST_EVENTS.runCancelled,
            data: runCancelledEventSchema.parse({
              workspaceId: data.workspaceId,
              userId: data.userId,
              runId: childId,
            }),
          })),
        );
      }
      const preempted = data.reason === "preempted";
      await step.run("mark-cancelled", async () => {
        const run = await deps.runs.get(ctx, asId(data.runId));
        if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) return false;
        await deps.approvals?.expireForRun(ctx, run.id);
        await deps.runs.update(ctx, run.id, {
          status: "cancelled",
          endedAt: new Date(),
          onlyIfActive: true,
        });
        await deps.runs.append(ctx, run.id, [
          runEvent("end-cancelled", "run.ended", {
            status: "cancelled",
            stopReason: preempted ? "preempted" : "user_stopped",
            usage: run.usage,
          }),
        ]);
        // Set aside for a person (M5.05): its chat says so, rather than the
        // run ending without a word.
        if (preempted && run.threadId) {
          await deps.harness.threads.addAgentMessage(
            { ...ctx, agentId: run.agentId, runId: run.id },
            { threadId: run.threadId, content: PREEMPTED_NOTE },
          );
        }
        return true;
      });
    },
  );

  const functions: InngestFunction.Any[] = [agentRun, agentRunCancelled, agentLearn];
  if (deps.tokenRefresh) functions.push(tokenRefreshFunction(inngest, deps.tokenRefresh));
  if (deps.blobSweep) functions.push(blobSweepFunction(inngest, deps.blobSweep));
  if (deps.routines) functions.push(routineTickFunction(inngest, deps.routines));
  if (deps.schedules) functions.push(scheduleFireFunction(inngest, deps.schedules));
  if (deps.memory) {
    functions.push(memoryConsolidationFunction(inngest, deps.harness.llm, deps.memory));
  }
  return functions;
}

/**
 * Nightly memory consolidation (ARCHITECTURE.md §8, M5.09). Every hour, the
 * workspaces where it is now 3 at night get their pass, as their owner, one
 * at a time so the shared model quota is spared.
 */
function memoryConsolidationFunction(
  inngest: Inngest.Any,
  llm: LLMGateway,
  memory: MemoryMaintenance,
) {
  return inngest.createFunction(
    {
      id: "memory-consolidate",
      name: "Consolidate memory overnight",
      // Nightly, or now for one workspace when asked.
      triggers: [
        { cron: MEMORY_CONSOLIDATION_CRON },
        { event: INNGEST_EVENTS.memoryConsolidationRequested },
      ],
      concurrency: [{ limit: 1 }],
      retries: 2,
    },
    async ({ event, step }) => {
      const asked =
        event.name === INNGEST_EVENTS.memoryConsolidationRequested
          ? memoryConsolidationRequestedEventSchema.parse(event.data)
          : null;
      return consolidateDue(
        llm,
        memory,
        inngestSteps(step),
        undefined,
        asked ? [asked] : undefined,
      );
    },
  );
}

/** One hourly tick: each due workspace's agents, its shared facts, then the rules that need no model. */
export async function consolidateDue(
  llm: LLMGateway,
  memory: MemoryMaintenance,
  steps: StepRunner,
  now: () => Date = () => new Date(),
  /** These workspaces now, whatever their local time. */
  only?: readonly { readonly workspaceId: string; readonly userId: string }[],
): Promise<Record<string, ConsolidationResult & { agents: number }>> {
  const due = only ?? (await steps.run("list-due", async () => memory.listDue(now())));
  const results: Record<string, ConsolidationResult & { agents: number }> = {};
  for (const w of due) {
    const ctx: TenantContext = { workspaceId: asId(w.workspaceId), userId: asId(w.userId) };
    // Step IDs must be unique in the function: prefix them with the workspace.
    const scoped: StepRunner = {
      run: (id, fn) => steps.run(`${w.workspaceId}-${id}`, fn),
    };
    const at = await scoped.run("started", async () => now().toISOString());
    const when = new Date(at);
    const agents = await scoped.run("agents", async () => memory.agents(ctx));
    const total = { merged: 0, added: 0, expired: 0, proposedSkills: 0, modelCalls: 0 };
    for (const agentId of [...agents, null]) {
      try {
        const r = await consolidateMemory(
          { ctx, agentId, now: when },
          { llm, maintenance: memory },
          scoped,
        );
        total.merged += r.merged;
        total.added += r.added;
        total.proposedSkills += r.proposedSkills;
        total.modelCalls += r.modelCalls;
      } catch {
        // One agent's pass failing (a model error after retries) doesn't stop the rest.
      }
    }
    total.expired = await scoped.run("expire", async () => memory.expireStale(ctx, when));
    await scoped.run("finish", async () => {
      await memory.finish(ctx, when);
      return true;
    });
    results[w.workspaceId] = { ...total, agents: agents.length };
  }
  return results;
}

const PREEMPTED_NOTE =
  "I set this aside to answer your message. Anything I had already done stays done; it runs again at its next time.";

/**
 * Routines on their schedules (M5.06). Every minute: find due routines and
 * fire each in its own step, as its owner. A routine moves on to its next
 * time as it fires, so a tick that runs twice starts nothing twice.
 */
function routineTickFunction(inngest: Inngest.Any, routines: RoutineRunner) {
  return inngest.createFunction(
    {
      id: "routine-tick",
      name: "Start due routines",
      triggers: [{ cron: ROUTINE_TICK_CRON }],
      concurrency: [{ limit: 1 }],
      retries: 1,
    },
    async ({ step }) => {
      const result = await fireDueRoutines(routines, inngestSteps(step));
      if (result.started.length > 0) {
        await step.sendEvent("start-runs", result.started.map(startEvent));
      }
      return result.counts;
    },
  );
}

/** One routine tick: what each due routine came to, and the runs to start. */
export async function fireDueRoutines(
  routines: RoutineRunner,
  steps: StepRunner,
): Promise<{ started: RunStart[]; counts: Record<string, number> }> {
  const due = await steps.run("list-due", async () => routines.listDue(new Date()));
  const started: RunStart[] = [];
  const counts: Record<string, number> = {};
  for (const r of due) {
    const fired = await steps.run(`fire-${r.routineId}-${r.dueAt}`, async () => {
      const ctx: TenantContext = { workspaceId: asId(r.workspaceId), userId: asId(r.userId) };
      try {
        return await routines.fire(ctx, r.routineId, new Date(r.dueAt), new Date());
      } catch {
        // Tried again at the next tick: the routine is still due.
        return { outcome: "failed" as const, run: null };
      }
    });
    counts[fired.outcome] = (counts[fired.outcome] ?? 0) + 1;
    if (fired.run) started.push(fired.run);
  }
  return { started, counts };
}

/**
 * A task or reminder an agent set for later (M5.07): sleep until it is due,
 * holding no process, then fire it. Cancelling it ends the sleep; the row is
 * checked when it fires too, so a cancel that raced the wake-up still holds.
 */
function scheduleFireFunction(inngest: Inngest.Any, schedules: ScheduleRunner) {
  return inngest.createFunction(
    {
      id: "schedule-fire",
      name: "Fire a scheduled task or reminder",
      triggers: [{ event: INNGEST_EVENTS.scheduleCreated }],
      cancelOn: [
        {
          event: INNGEST_EVENTS.scheduleCancelled,
          if: "async.data.scheduleId == event.data.scheduleId",
        },
      ],
      retries: 3,
    },
    async ({ event, step }) => {
      const data = scheduleCreatedEventSchema.parse(event.data);
      await step.sleepUntil("wait", new Date(data.dueAt));
      const fired = await step.run("fire", async () => {
        const ctx: TenantContext = {
          workspaceId: asId(data.workspaceId),
          userId: asId(data.userId),
        };
        return schedules.fire(ctx, data.scheduleId, new Date());
      });
      if (fired.run) await step.sendEvent("start-run", startEvent(fired.run));
      return fired.outcome;
    },
  );
}

/**
 * Refresh app sign-ins shortly before their access tokens run out (M4.06), so
 * a routine or a run that starts after a quiet hour finds them working. Each
 * sign-in is its own step: one provider that is down doesn't hold up the rest,
 * and it is tried again at the next tick.
 */
/** The object store's orphan sweep (ADR-0047): one step, one at a time. */
function blobSweepFunction(inngest: Inngest.Any, sweeper: BlobSweeper) {
  return inngest.createFunction(
    {
      id: "blob-sweep",
      name: "Remove files no artifact points at",
      triggers: [{ cron: BLOB_SWEEP_CRON }],
      concurrency: [{ limit: 1 }],
      retries: 1,
    },
    async ({ step }) => step.run("sweep", () => sweeper.sweep(new Date())),
  );
}

function tokenRefreshFunction(inngest: Inngest.Any, refresher: TokenRefresher) {
  return inngest.createFunction(
    {
      id: "token-refresh",
      name: "Refresh app sign-ins",
      triggers: [{ cron: TOKEN_REFRESH_CRON }],
      concurrency: [{ limit: 1 }],
      retries: 1,
    },
    async ({ step }) => refreshDue(refresher, inngestSteps(step)),
  );
}

/** One tick of the token refresh: what each due sign-in came to, counted. */
export async function refreshDue(
  refresher: TokenRefresher,
  steps: StepRunner,
  now: () => number = Date.now,
): Promise<Partial<Record<TokenRefreshOutcome | "failed", number>> & { due: number }> {
  const due = await steps.run("list-due", async () =>
    (await refresher.listDue(new Date(now() + TOKEN_REFRESH_AHEAD_MS))).map((c) => ({
      workspaceId: c.workspaceId,
      userId: c.userId,
      mcpServerId: c.mcpServerId,
    })),
  );
  const counts: Partial<Record<TokenRefreshOutcome | "failed", number>> = {};
  for (const c of due) {
    const outcome = await steps.run(`refresh-${c.mcpServerId}-${c.userId}`, async () => {
      const ctx: TenantContext = { workspaceId: asId(c.workspaceId), userId: asId(c.userId) };
      try {
        return await refresher.refresh(ctx, c.mcpServerId);
      } catch {
        // The refresher logs why; the sign-in is left as it was.
        return "failed" as const;
      }
    });
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return { due: due.length, ...counts };
}
