import { describe, expect, it } from "vitest";
import { createCircuitBreaker } from "./breaker";
import { ModelError } from "./errors";
import { createMemoryRateLimiter, type Clock } from "./queue";

/** A clock that only moves when something sleeps. */
function fakeClock(start = Date.UTC(2026, 9, 1, 12, 0, 0)): Clock & { t: number } {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
}

describe("rate limiter", () => {
  const free = { bucket: "test:free", perMinute: 2 };

  it("lets calls through up to the per-minute limit, then waits for the window", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter(clock);
    const start = clock.t;
    await limiter.acquire([free], { maxWaitMs: 120_000 });
    await limiter.acquire([free], { maxWaitMs: 120_000 });
    expect(clock.t).toBe(start);
    expect(limiter.waitTime([free])).toBe(60_000);
    await limiter.acquire([free], { maxWaitMs: 120_000 });
    expect(clock.t).toBe(start + 60_000);
  });

  it("gives up with `capacity` and a retry time when the wait is too long", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter(clock);
    await limiter.acquire([free], { maxWaitMs: 0 });
    await limiter.acquire([free], { maxWaitMs: 0 });
    const error = await limiter.acquire([free], { maxWaitMs: 1_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ modelCode: "capacity", retryAfterMs: 60_000 });
  });

  it("serves waiters first come, first served", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter(clock);
    const one = { bucket: "test:one", perMinute: 1 };
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        limiter.acquire([one], { maxWaitMs: 600_000 }).then(() => order.push(name)),
      ),
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("holds a paused bucket until the provider's reset time", async () => {
    const clock = fakeClock();
    const limiter = createMemoryRateLimiter(clock);
    limiter.pause("test:free", clock.t + 5_000);
    expect(limiter.waitTime([free])).toBe(5_000);
  });

  it("resets the daily quota at UTC midnight", async () => {
    const clock = fakeClock(Date.UTC(2026, 9, 1, 23, 0, 0));
    const limiter = createMemoryRateLimiter(clock);
    const daily = { bucket: "test:day", perDay: 1 };
    await limiter.acquire([daily], { maxWaitMs: 0 });
    expect(limiter.waitTime([daily])).toBe(60 * 60 * 1000);
  });
});

describe("circuit breaker", () => {
  it("opens after three failures, then lets one trial through after the cool-down", () => {
    let t = 0;
    const breaker = createCircuitBreaker({ threshold: 3, cooldownMs: 1_000, now: () => t });
    for (let i = 0; i < 3; i++) breaker.failure("m");
    expect(breaker.isOpen("m")).toBe(true);
    expect(breaker.canTry("m")).toBe(false);

    t = 1_000;
    expect(breaker.isOpen("m")).toBe(false);
    expect(breaker.canTry("m")).toBe(true);
    expect(breaker.canTry("m")).toBe(false); // only one trial at a time

    breaker.failure("m"); // trial failed: cool-down doubles
    t = 2_500;
    expect(breaker.canTry("m")).toBe(false);
    t = 3_000;
    expect(breaker.canTry("m")).toBe(true);
    breaker.success("m");
    expect(breaker.isOpen("m")).toBe(false);
  });
});
