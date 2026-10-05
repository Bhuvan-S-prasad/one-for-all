import { NonRetriableError, RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";
import { inngestSteps } from "./functions";

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
});
