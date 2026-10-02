import { ModelError } from "./errors";
import type { RateLimit } from "./provider";

// The shared queue for provider quotas (ARCHITECTURE.md §11). Every model call
// from every agent waits here, so OpenRouter's 20 free requests a minute are
// spread across the team instead of failing with 429s.
//
// In memory: right for the self-host bundle, where one process runs every
// agent. Cloud mode, with several workers, needs a shared implementation of
// the same interface (Postgres or Valkey).

export interface AcquireOptions {
  /** Give up and throw `capacity` if a slot is further away than this. */
  readonly maxWaitMs: number;
  readonly signal?: AbortSignal;
}

export interface RateLimiter {
  /** Take a slot in every bucket, waiting in line if needed. */
  acquire(limits: readonly RateLimit[], options: AcquireOptions): Promise<void>;
  /** Milliseconds until every bucket has a free slot; 0 means now. Takes nothing. */
  waitTime(limits: readonly RateLimit[]): number;
  /** The provider said slow down (HTTP 429): hold the bucket until `untilMs`. */
  pause(bucket: string, untilMs: number): void;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

const MINUTE = 60_000;

interface BucketState {
  /** Grant times within the last minute, oldest first. */
  minute: number[];
  day: { date: string; count: number };
  pausedUntil: number;
  /** End of the line: each waiter chains onto it, so slots go first come, first served. */
  tail: Promise<void>;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnight(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function createMemoryRateLimiter(clock: Clock = systemClock): RateLimiter {
  const buckets = new Map<string, BucketState>();

  function state(bucket: string): BucketState {
    let current = buckets.get(bucket);
    if (!current) {
      current = {
        minute: [],
        day: { date: utcDate(clock.now()), count: 0 },
        pausedUntil: 0,
        tail: Promise.resolve(),
      };
      buckets.set(bucket, current);
    }
    return current;
  }

  /** When the bucket next has a slot (absolute ms). */
  function nextFree(limit: RateLimit, now: number): number {
    const s = state(limit.bucket);
    let at = Math.max(now, s.pausedUntil);
    if (limit.perMinute !== undefined) {
      while (s.minute.length > 0 && (s.minute[0] ?? 0) <= now - MINUTE) s.minute.shift();
      if (s.minute.length >= limit.perMinute) {
        at = Math.max(at, (s.minute[s.minute.length - limit.perMinute] ?? now) + MINUTE);
      }
    }
    if (limit.perDay !== undefined) {
      if (s.day.date !== utcDate(now)) s.day = { date: utcDate(now), count: 0 };
      if (s.day.count >= limit.perDay) at = Math.max(at, nextUtcMidnight(now));
    }
    return at;
  }

  function record(limit: RateLimit, now: number): void {
    const s = state(limit.bucket);
    s.minute.push(now);
    s.day.count += 1;
  }

  async function acquireOne(limit: RateLimit, deadline: number, signal?: AbortSignal) {
    const s = state(limit.bucket);
    const turn = s.tail.then(async () => {
      for (;;) {
        const now = clock.now();
        const at = nextFree(limit, now);
        if (at <= now) return record(limit, now);
        if (at > deadline) {
          throw new ModelError("capacity", "Waiting for model capacity", {
            retryAfterMs: at - now,
          });
        }
        await clock.sleep(at - now, signal);
      }
    });
    // A waiter that gives up must not block the ones behind it.
    s.tail = turn.catch(() => {});
    return turn;
  }

  return {
    async acquire(limits, options) {
      const deadline = clock.now() + options.maxWaitMs;
      // A fixed order, so two calls never wait on each other's buckets.
      const sorted = [...limits].sort((a, b) => a.bucket.localeCompare(b.bucket));
      for (const limit of sorted) await acquireOne(limit, deadline, options.signal);
    },

    waitTime(limits) {
      const now = clock.now();
      return Math.max(0, ...limits.map((limit) => nextFree(limit, now) - now));
    },

    pause(bucket, untilMs) {
      const s = state(bucket);
      s.pausedUntil = Math.max(s.pausedUntil, untilMs);
    },
  };
}
