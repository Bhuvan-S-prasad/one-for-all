import { AppError, type ErrorCode, type LLMAttempt, type ModelErrorCode } from "@ofa/core";
import { APICallError } from "ai";

/**
 * A model call that could not be served by any model in the tier's chain.
 * `retryAfterMs` is set when waiting will help (quota or capacity), so the
 * orchestrator can retry the step later instead of failing the run.
 */
export class ModelError extends AppError {
  readonly modelCode: ModelErrorCode;
  readonly retryAfterMs: number | undefined;
  readonly attempts: readonly LLMAttempt[];

  constructor(
    modelCode: ModelErrorCode,
    message: string,
    options: { retryAfterMs?: number; attempts?: readonly LLMAttempt[] } = {},
  ) {
    super(appCodeFor(modelCode), message, { modelCode, retryAfterMs: options.retryAfterMs });
    this.name = "ModelError";
    this.modelCode = modelCode;
    this.retryAfterMs = options.retryAfterMs;
    this.attempts = options.attempts ?? [];
  }
}

function appCodeFor(code: ModelErrorCode): ErrorCode {
  switch (code) {
    case "rate_limited":
    case "capacity":
      return "rate_limited";
    case "auth":
    case "bad_request":
    case "context_length":
      return "bad_request";
    default:
      return "internal";
  }
}

export interface ClassifiedError {
  readonly code: ModelErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
  /**
   * For `rate_limited`: the account's own quota is used up (the response says
   * `X-RateLimit-Remaining: 0`), so every model sharing that quota must wait.
   * Otherwise the limit is upstream of one model and only that model waits;
   * OpenRouter answers 429 when a free model's host is busy.
   */
  readonly quotaExhausted?: boolean;
}

/** `Retry-After` (seconds or a date), or OpenRouter-style `X-RateLimit-Reset` (epoch ms). */
export function retryAfterFromHeaders(
  headers: Record<string, string> | undefined,
  now: number,
): number | undefined {
  if (!headers) return undefined;
  const get = (name: string) =>
    Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];

  const retryAfter = get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    // Epoch milliseconds (OpenRouter) or seconds (others).
    const resetMs = reset > 1e12 ? reset : reset * 1000;
    return Math.max(0, resetMs - now);
  }
  return undefined;
}

const CONTEXT_LENGTH =
  /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|reduce the length/i;

/** Map any error from a provider call to a provider-independent code. */
export function classifyModelError(error: unknown, now: number = Date.now()): ClassifiedError {
  if (error instanceof ModelError) {
    return { code: error.modelCode, message: error.message, retryAfterMs: error.retryAfterMs };
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;
    const text = `${error.message} ${error.responseBody ?? ""}`;
    const message = error.message.slice(0, 500);
    // 401: the key itself is wrong. 402: the account is out of credit. Both
    // affect every model at the provider.
    if (status === 401) return { code: "auth", message };
    if (status === 402) {
      return { code: "auth", message: `The provider refused the request: ${message}` };
    }
    // 403 is about one model, not the key: OpenRouter answers 403 for free
    // models it reserves for listed apps, or for moderation. Try the next model.
    if (status === 403) return { code: "bad_request", message: `Model refused: ${message}` };
    if (status === 429) {
      const remaining = Object.entries(error.responseHeaders ?? {}).find(
        ([key]) => key.toLowerCase() === "x-ratelimit-remaining",
      )?.[1];
      return {
        code: "rate_limited",
        message,
        retryAfterMs: retryAfterFromHeaders(error.responseHeaders, now),
        quotaExhausted: remaining !== undefined && Number(remaining) <= 0,
      };
    }
    if (status === 408) return { code: "timeout", message };
    if (CONTEXT_LENGTH.test(text)) return { code: "context_length", message };
    // 404: model removed, or no endpoint for it supports the request (e.g. tools).
    if (status === 404 || status >= 500) return { code: "unavailable", message };
    if (status >= 400) return { code: "bad_request", message };
    return { code: error.isRetryable ? "unavailable" : "unknown", message };
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return { code: "timeout", message: "The model timed out" };
    // fetch() network failures (DNS, refused, reset).
    if (error.name === "TypeError" && /fetch/i.test(error.message)) {
      return { code: "unavailable", message: error.message };
    }
    return { code: "unknown", message: error.message.slice(0, 500) };
  }
  return { code: "unknown", message: String(error).slice(0, 500) };
}
