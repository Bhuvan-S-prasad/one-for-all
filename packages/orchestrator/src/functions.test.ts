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
});
