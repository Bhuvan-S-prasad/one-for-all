import { AppError } from "@ofa/core";
import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Requests allowed per key per window. */
  readonly max: number;
  /** Which bucket a request counts against (usually the client IP). */
  readonly key: (c: Parameters<MiddlewareHandler>[0]) => string;
  /** Clock, for tests. */
  readonly now?: () => number;
}

/**
 * Fixed-window, in-memory rate limiter. Enough for one self-hosted process
 * guarding login and setup against password guessing; cloud mode swaps in a
 * shared store (M7.06).
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const time = now();
    const key = options.key(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= time) {
      bucket = { count: 0, resetAt: time + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    // Keep the map from growing without bound.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (b.resetAt <= time) buckets.delete(k);
    }

    if (bucket.count > options.max) {
      c.header("Retry-After", String(Math.ceil((bucket.resetAt - time) / 1000)));
      throw new AppError("rate_limited", "Too many attempts. Try again shortly.");
    }
    await next();
  };
}
