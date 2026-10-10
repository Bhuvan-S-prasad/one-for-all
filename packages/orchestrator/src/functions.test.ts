import {
  asId,
  type AgentId,
  type MessageId,
  type RunId,
  type TenantContext,
  type ThreadId,
  type TokenRefresher,
  type RoutineRunner,
} from "@ofa/core";
import { NonRetriableError, RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";
import { fireDueRoutines, inngestSteps, refreshDue, TOKEN_REFRESH_AHEAD_MS } from "./functions";

// A stand-in for Inngest's `step.run`: runs the function, passes errors through.
const step = { run: (_id: string, fn: () => Promise<unknown>) => fn() };

function modelError(modelCode: string, retryAfterMs?: number) {
  return Object.assign(new Error(`model: ${modelCode}`), { modelCode, retryAfterMs });
}

describe("inngestSteps", () => {
  it("returns the step's result", async () => {
    expect(await inngestSteps(step).run("a", async () => ({ ok: 1 }))).toEqual({ ok: 1 });
  });

  it("asks Inngest to retry later when the model is out of capacity", async () => {
    const error = await inngestSteps(step)
      .run("a", () => Promise.reject(modelError("capacity", 30_000)))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryAfterError);
  });

  it("stops retrying when waiting will not help", async () => {
    const error = await inngestSteps(step)
      .run("a", () => Promise.reject(modelError("auth")))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetriableError);
  });

  it("leaves other errors to Inngest's normal retries", async () => {
    const error = await inngestSteps(step)
      .run("a", () => Promise.reject(new Error("db down")))
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NonRetriableError);
    expect((error as Error).message).toBe("db down");
  });

  it("waits for an event matching one field, and refuses values that could escape the match", async () => {
    const waits: unknown[] = [];
    const steps = inngestSteps({
      ...step,
      waitForEvent: async (id, opts) => {
        waits.push({ id, ...opts });
        return { data: { approvalId: "4f6fb9f0-cf66-4467-bbda-cae2aa7e6fc1" } };
      },
    });
    const wait = (value: string) =>
      steps.waitForEvent!("tool-0-0-wait", {
        event: "approval/decided",
        field: "approvalId",
        value,
        timeoutMs: 60_000,
      });
    expect(await wait("4f6fb9f0-cf66-4467-bbda-cae2aa7e6fc1")).toEqual({
      approvalId: "4f6fb9f0-cf66-4467-bbda-cae2aa7e6fc1",
    });
    expect(waits).toEqual([
      {
        id: "tool-0-0-wait",
        event: "approval/decided",
        timeout: 60_000,
        if: "async.data.approvalId == '4f6fb9f0-cf66-4467-bbda-cae2aa7e6fc1'",
      },
    ]);
    await expect(wait("x' || true || '")).rejects.toThrow(/Unsafe/);
  });

  it("runs a handoff's child through invoke and reads back what it came to (M5.01)", async () => {
    const child = {
      agentId: asId<AgentId>("res"),
      runId: asId<RunId>("child_1"),
      threadId: asId<ThreadId>("handoff_1"),
      messageId: asId<MessageId>("brief_1"),
    };
    const calls: unknown[] = [];
    const steps = inngestSteps(step, async (id, request, timeoutMs) => {
      calls.push({ id, request, timeoutMs });
      return {
        status: "succeeded",
        stopReason: "final_answer",
        usage: {},
        messageId: "m",
        reply: "Done: 3 papers.",
        tainted: false,
        learn: false,
      };
    });
    expect(await steps.invokeRun!("tool-0-0-delegate", child, { timeoutMs: 500 })).toEqual({
      status: "succeeded",
      stopReason: "final_answer",
      reply: "Done: 3 papers.",
      tainted: false,
    });
    // Durable waits round up to a second.
    expect(calls).toEqual([{ id: "tool-0-0-delegate", request: child, timeoutMs: 1_000 }]);

    // A child that failed after its retries, or ran out of time, comes back as nothing.
    const failing = inngestSteps(step, () => Promise.reject(new Error("function failed")));
    expect(await failing.invokeRun!("x", child, { timeoutMs: 60_000 })).toBeNull();
    // Without invoke, runs can't hand work over.
    expect(inngestSteps(step).invokeRun).toBeUndefined();
  });
});

describe("token refresh (M4.06)", () => {
  it("refreshes each due sign-in in its own step, as its person, and counts what happened", async () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    let asked: Date | undefined;
    const refreshed: [TenantContext, string][] = [];
    const due = (n: number) => ({
      workspaceId: "ws",
      userId: `user-${n}`,
      mcpServerId: `server-${n}`,
      expiresAt: new Date(now),
    });
    const refresher: TokenRefresher = {
      listDue: async (before) => {
        asked = before;
        return [due(1), due(2), due(3), due(4)];
      },
      refresh: async (ctx, serverId) => {
        refreshed.push([ctx, serverId]);
        if (serverId === "server-2") throw new Error("provider down");
        if (serverId === "server-3") return "sign_in_required";
        return "refreshed";
      },
    };
    const ids: string[] = [];
    const steps = inngestSteps({ run: (id, fn) => (ids.push(id), fn()) });
    expect(await refreshDue(refresher, steps, () => now)).toEqual({
      due: 4,
      refreshed: 2,
      failed: 1,
      sign_in_required: 1,
    });
    expect(asked).toEqual(new Date(now + TOKEN_REFRESH_AHEAD_MS));
    // One provider being down didn't stop the others.
    expect(refreshed.map(([ctx, id]) => [ctx.userId, id])).toEqual([
      ["user-1", "server-1"],
      ["user-2", "server-2"],
      ["user-3", "server-3"],
      ["user-4", "server-4"],
    ]);
    expect(ids).toEqual([
      "list-due",
      "refresh-server-1-user-1",
      "refresh-server-2-user-2",
      "refresh-server-3-user-3",
      "refresh-server-4-user-4",
    ]);
  });
});

describe("routine tick (M5.06)", () => {
  it("fires each due routine in its own step and collects the runs to start", async () => {
    const due = (n: number) => ({
      workspaceId: `ws-${n}`,
      userId: `user-${n}`,
      routineId: `routine-${n}`,
      dueAt: "2026-10-12T07:00:00.000Z",
    });
    const fired: string[] = [];
    const routines: RoutineRunner = {
      listDue: async () => [due(1), due(2), due(3)],
      fire: async (ctx, routineId, dueAt) => {
        fired.push(`${ctx.userId}:${routineId}:${dueAt.toISOString()}`);
        if (routineId === "routine-2") return { outcome: "busy", run: null };
        if (routineId === "routine-3") throw new Error("database blip");
        return {
          outcome: "started",
          run: {
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            agentId: "agent-1",
            threadId: "thread-1",
            messageId: "msg-1",
            runId: "run-1",
            trigger: "routine",
          },
        };
      },
    };
    const ids: string[] = [];
    const steps = inngestSteps({ run: (id, fn) => (ids.push(id), fn()) });
    const result = await fireDueRoutines(routines, steps);
    expect(result.counts).toEqual({ started: 1, busy: 1, failed: 1 });
    expect(result.started.map((r) => r.runId)).toEqual(["run-1"]);
    expect(fired).toEqual([
      "user-1:routine-1:2026-10-12T07:00:00.000Z",
      "user-2:routine-2:2026-10-12T07:00:00.000Z",
      "user-3:routine-3:2026-10-12T07:00:00.000Z",
    ]);
    // One step per due time: a retried tick finds each one memoized.
    expect(ids).toEqual([
      "list-due",
      "fire-routine-1-2026-10-12T07:00:00.000Z",
      "fire-routine-2-2026-10-12T07:00:00.000Z",
      "fire-routine-3-2026-10-12T07:00:00.000Z",
    ]);
  });
});
