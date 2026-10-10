import {
  EMPTY_RUN_USAGE,
  INNGEST_EVENTS,
  messageReceivedEventSchema,
  runCancelledEventSchema,
  runSucceededEventSchema,
} from "@ofa/contracts";
import {
  asId,
  type ApprovalStore,
  type RunContext,
  type RunStore,
  type StepRunner,
  type TenantContext,
  type ThreadId,
  type TokenRefresher,
  type TokenRefreshOutcome,
} from "@ofa/core";
import { learnFromRun, runAgent, runEvent, type HarnessDeps } from "@ofa/harness";
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
}

/** How often sign-ins are checked, and how far ahead of expiry they are refreshed. */
export const TOKEN_REFRESH_CRON = "*/10 * * * *";
export const TOKEN_REFRESH_AHEAD_MS = 15 * 60_000;

/** Errors that waiting will not fix: a missing key, a malformed request. */
const NOT_RETRYABLE = new Set(["auth", "bad_request", "context_length"]);

/**
 * Adapt Inngest's `step.run` to the harness's `StepRunner`, and turn model
 * errors into Inngest's retry signals: wait for capacity, or stop retrying.
 */
export function inngestSteps(step: {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
  waitForEvent?: (
    id: string,
    opts: { event: string; timeout: number; if: string },
  ) => Promise<{ data?: unknown } | null>;
}): StepRunner {
  const waitForEvent = step.waitForEvent?.bind(step);
  return {
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
  const agentRun = inngest.createFunction(
    {
      id: "agent-run",
      name: "Agent run",
      triggers: [{ event: INNGEST_EVENTS.messageReceived }],
      // One run at a time per agent; more messages wait their turn.
      concurrency: [{ key: "event.data.agentId", limit: 1 }],
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
      const result = await runAgent(
        { ctx, threadId: asId<ThreadId>(data.threadId), trigger: data.trigger },
        deps.harness,
        inngestSteps(step),
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
            stopReason: "user_stopped",
            usage: run.usage,
          }),
        ]);
        return true;
      });
    },
  );

  const functions: InngestFunction.Any[] = [agentRun, agentRunCancelled, agentLearn];
  if (deps.tokenRefresh) functions.push(tokenRefreshFunction(inngest, deps.tokenRefresh));
  return functions;
}

/**
 * Refresh app sign-ins shortly before their access tokens run out (M4.06), so
 * a routine or a run that starts after a quiet hour finds them working. Each
 * sign-in is its own step: one provider that is down doesn't hold up the rest,
 * and it is tried again at the next tick.
 */
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
