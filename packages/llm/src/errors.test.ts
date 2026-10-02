import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyModelError, retryAfterFromHeaders } from "./errors";
import { parseModelList, parseModelRef } from "./tiers";

function apiError(
  statusCode: number,
  extra: Partial<{ body: string; headers: Record<string, string> }> = {},
) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://provider.test/v1/chat",
    requestBodyValues: {},
    statusCode,
    responseBody: extra.body,
    responseHeaders: extra.headers,
  });
}

describe("classifyModelError", () => {
  const now = Date.UTC(2026, 9, 1);

  it("maps HTTP statuses to provider-independent codes", () => {
    expect(classifyModelError(apiError(401)).code).toBe("auth");
    expect(classifyModelError(apiError(402)).code).toBe("auth");
    // A 403 refuses one model (OpenRouter gates some free models by app), not the key.
    expect(classifyModelError(apiError(403)).code).toBe("bad_request");
    expect(classifyModelError(apiError(404)).code).toBe("unavailable");
    expect(classifyModelError(apiError(503)).code).toBe("unavailable");
    expect(classifyModelError(apiError(400)).code).toBe("bad_request");
    expect(
      classifyModelError(apiError(400, { body: "This model's maximum context length is 8192" }))
        .code,
    ).toBe("context_length");
  });

  it("reads when to retry after a 429", () => {
    const error = apiError(429, { headers: { "Retry-After": "7" } });
    expect(classifyModelError(error, now)).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7_000,
    });
  });

  it("understands OpenRouter's reset header and HTTP dates", () => {
    expect(retryAfterFromHeaders({ "X-RateLimit-Reset": String(now + 9_000) }, now)).toBe(9_000);
    expect(retryAfterFromHeaders({ "retry-after": new Date(now + 3_000).toUTCString() }, now)).toBe(
      3_000,
    );
    expect(retryAfterFromHeaders({}, now)).toBeUndefined();
  });

  it("treats timeouts and network failures as the model being unavailable", () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(classifyModelError(timeout).code).toBe("timeout");
    expect(classifyModelError(new TypeError("fetch failed")).code).toBe("unavailable");
  });
});

describe("model references", () => {
  const providers = ["openrouter", "ollama"];

  it("keeps colons that belong to the model ID", () => {
    expect(parseModelRef("qwen/qwen3.8-27b:free", providers, "openrouter")).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3.8-27b:free",
    });
    expect(parseModelRef("openrouter:qwen/qwen3.8-27b:free", providers, "ollama")).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3.8-27b:free",
    });
    expect(parseModelRef("ollama:llama3.2:3b", providers, "openrouter")).toEqual({
      provider: "ollama",
      model: "llama3.2:3b",
    });
  });

  it("parses comma-separated lists and ignores blanks", () => {
    expect(parseModelList(" a:free , ,ollama:b ", providers, "openrouter")).toEqual([
      { provider: "openrouter", model: "a:free" },
      { provider: "ollama", model: "b" },
    ]);
    expect(parseModelList(undefined, providers, "openrouter")).toEqual([]);
  });
});
