import { asId, type TenantContext, type ToolDescriptor } from "@ofa/core";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createModelGateway, type ModelGatewayOptions } from "./gateway";
import { ModelError } from "./errors";
import type { ModelDetails, ModelProvider, RateLimit, TierModels } from "./provider";
import { createOpenRouterProvider } from "./providers/openrouter";
import type { Clock } from "./queue";

// The gateway against fake providers: no network, no keys. The last block
// runs the real OpenRouter adapter against a fake HTTP server.

type DoGenerate = NonNullable<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doGenerate"]
>;
type Behaviour = Extract<DoGenerate, (...args: never[]) => unknown>;
type CallOptions = Parameters<Behaviour>[0];

const ctx: TenantContext = { workspaceId: asId("ws_1"), userId: asId("usr_1") };
const TEST_KEY = "test-key-not-real-0123456789";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});

const say =
  (text: string): Behaviour =>
  async () => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(1_000, 500),
    warnings: [],
  });

const callTool =
  (toolName: string, input: unknown): Behaviour =>
  async () => ({
    content: [{ type: "tool-call", toolCallId: "call_1", toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: usage(100, 20),
    warnings: [],
  });

const fail =
  (statusCode: number, headers?: Record<string, string>): Behaviour =>
  async () => {
    throw new APICallError({
      message: `HTTP ${statusCode} (key ${TEST_KEY})`,
      url: "https://provider.test",
      requestBodyValues: {},
      statusCode,
      responseHeaders: headers,
    });
  };

interface FakeProvider extends ModelProvider {
  readonly calls: { model: string; apiKey: string | undefined; options: CallOptions }[];
}

function fakeProvider(
  id: string,
  models: Record<string, Behaviour>,
  extra: {
    tiers?: TierModels;
    limits?: (model: string) => RateLimit[];
    details?: ModelDetails[];
  } = {},
): FakeProvider {
  const calls: FakeProvider["calls"] = [];
  const names = Object.keys(models);
  return {
    id,
    label: id,
    requiresApiKey: true,
    defaultTiers: extra.tiers ?? { fast: names, standard: names, strong: names },
    calls,
    languageModel(model, { apiKey }) {
      const behaviour = models[model];
      if (!behaviour) throw new Error(`no fake model ${model}`);
      return new MockLanguageModelV4({
        provider: id,
        modelId: model,
        doGenerate: async (options) => {
          calls.push({ model, apiKey, options });
          return behaviour(options);
        },
      });
    },
    listModels: async () => extra.details ?? [],
    rateLimits: (model) => extra.limits?.(model) ?? [],
  };
}

/** Time stands still unless something sleeps. */
function fakeClock(): Clock {
  let t = Date.UTC(2026, 9, 1, 12);
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function gateway(
  providers: [ModelProvider, ...ModelProvider[]],
  extra: Partial<ModelGatewayOptions> = {},
) {
  return createModelGateway({
    providers,
    apiKey: async () => TEST_KEY,
    clock: fakeClock(),
    ...extra,
  });
}

const user = (content: string) => [{ role: "user" as const, content }];

const webSearch: ToolDescriptor = {
  name: "web.search",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnly: true },
  source: "builtin",
};

describe("model gateway", () => {
  it("answers through the tier's first model and meters cost from the catalog", async () => {
    const provider = fakeProvider(
      "fake",
      { "model-a": say("Hello") },
      {
        details: [
          {
            id: "model-a",
            contextWindow: 32_000,
            maxOutputTokens: 4_000,
            supportsTools: true,
            pricing: { inputPerMTok: 2, outputPerMTok: 10 },
          },
        ],
      },
    );
    const response = await gateway([provider]).generate(
      { tier: "fast", messages: user("Hi") },
      ctx,
    );
    expect(response).toMatchObject({
      text: "Hello",
      provider: "fake",
      model: "model-a",
      finishReason: "stop",
      attempts: [],
      usage: { inputTokens: 1_000, outputTokens: 500, costUsd: 0.007 },
    });
    expect(provider.calls[0]?.apiKey).toBe(TEST_KEY);
  });

  it("sends tool names the provider accepts and maps calls back", async () => {
    const provider = fakeProvider("fake", { m: callTool("web_search", { query: "pgvector" }) });
    const response = await gateway([provider]).generate(
      { tier: "fast", messages: user("Search"), tools: [webSearch] },
      ctx,
    );
    const sent = provider.calls[0]?.options.tools?.map((t) => ("name" in t ? t.name : ""));
    expect(sent).toEqual(["web_search"]);
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "web.search", args: { query: "pgvector" } },
    ]);
  });

  // Schema checks on arguments belong to the tool registry (M2.13), which owns
  // each tool's schema; the gateway flags what it can see: made-up tools and
  // arguments that are not JSON at all.
  it("flags calls to tools that do not exist or with unreadable arguments", async () => {
    const unknown = fakeProvider("fake", { m: callTool("send_money", { to: "x" }) });
    const [madeUp] = (
      await gateway([unknown]).generate(
        { tier: "fast", messages: user("x"), tools: [webSearch] },
        ctx,
      )
    ).toolCalls;
    expect(madeUp?.invalid).toMatch(/Unknown tool/);

    const badArgs = fakeProvider("fake", {
      m: async () => ({
        content: [{ type: "tool-call", toolCallId: "c", toolName: "web_search", input: "{query:" }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: usage(1, 1),
        warnings: [],
      }),
    });
    const [wrong] = (
      await gateway([badArgs]).generate(
        { tier: "fast", messages: user("x"), tools: [webSearch] },
        ctx,
      )
    ).toolCalls;
    expect(wrong?.name).toBe("web.search");
    expect(wrong?.invalid).toMatch(/Invalid arguments/);
  });

  it("converts tool history for the provider", async () => {
    const provider = fakeProvider("fake", { m: say("Done") });
    await gateway([provider]).generate(
      {
        tier: "fast",
        tools: [webSearch],
        messages: [
          { role: "system", content: "You are a test." },
          { role: "user", content: "Search" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "web.search", args: { query: "x" } }],
          },
          { role: "tool", toolCallId: "c1", toolName: "web.search", content: "result" },
        ],
      },
      ctx,
    );
    const prompt = provider.calls[0]?.options.prompt ?? [];
    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(JSON.stringify(prompt[3])).toContain("web_search");
  });

  it("falls back to the next model when one is down, and records the attempt", async () => {
    const provider = fakeProvider("fake", { down: fail(503), up: say("Fallback") });
    const response = await gateway([provider]).generate(
      { tier: "standard", messages: user("x") },
      ctx,
    );
    expect(response.model).toBe("up");
    expect(response.attempts).toEqual([
      {
        provider: "fake",
        model: "down",
        code: "unavailable",
        message: "HTTP 503 (key [REDACTED])",
      },
    ]);
  });

  it("falls back when a model returns nothing at all", async () => {
    const provider = fakeProvider("fake", { empty: say(""), up: say("ok") });
    const response = await gateway([provider]).generate({ tier: "fast", messages: user("x") }, ctx);
    expect(response.model).toBe("up");
    expect(response.attempts[0]?.message).toMatch(/empty response/);
  });

  it("stops trying a provider whose key is refused, and says so", async () => {
    const provider = fakeProvider("fake", { a: fail(401), b: say("never") });
    const error = await gateway([provider])
      .generate({ tier: "fast", messages: user("x") }, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ modelCode: "auth" });
    expect(provider.calls.map((c) => c.model)).toEqual(["a"]);
  });

  it("a model that refuses (403) does not stop the provider's other models", async () => {
    const provider = fakeProvider("fake", { gated: fail(403), open: say("ok") });
    const response = await gateway([provider]).generate({ tier: "fast", messages: user("x") }, ctx);
    expect(response.model).toBe("open");
    expect(response.attempts[0]).toMatchObject({ model: "gated", code: "bad_request" });
  });

  it("does not call a provider without a key", async () => {
    const provider = fakeProvider("fake", { a: say("never") });
    const error = await gateway([provider], { apiKey: async () => undefined })
      .generate({ tier: "fast", messages: user("x") }, ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ modelCode: "auth" });
    expect(provider.calls).toHaveLength(0);
  });

  it("pauses a rate-limited model and reports when to retry", async () => {
    const provider = fakeProvider("fake", { a: fail(429, { "retry-after": "30" }) });
    const g = gateway([provider], { maxQueueWaitMs: 0 });
    const first = await g
      .generate({ tier: "fast", messages: user("x") }, ctx)
      .catch((e: unknown) => e);
    expect(first).toMatchObject({ modelCode: "rate_limited", retryAfterMs: 30_000 });

    // The model is paused: the next call does not even reach it.
    const second = await g
      .generate({ tier: "fast", messages: user("x") }, ctx)
      .catch((e: unknown) => e);
    expect(second).toMatchObject({ modelCode: "capacity" });
    expect(provider.calls).toHaveLength(1);
  });

  it("a busy upstream pauses one model; a spent account quota pauses all that share it", async () => {
    const shared = { bucket: "fake:free", perMinute: 20 };
    const limits = () => [shared];
    const busy = fakeProvider("fake", { a: fail(429), b: say("b is fine") }, { limits });
    const g1 = gateway([busy], { maxQueueWaitMs: 0 });
    expect((await g1.generate({ tier: "fast", messages: user("x") }, ctx)).model).toBe("b");
    expect((await g1.generate({ tier: "fast", messages: user("x") }, ctx)).model).toBe("b");

    const spent = fakeProvider(
      "fake",
      { a: fail(429, { "x-ratelimit-remaining": "0", "retry-after": "40" }), b: say("never") },
      { limits },
    );
    const g2 = gateway([spent], { maxQueueWaitMs: 0 });
    const error = await g2
      .generate({ tier: "fast", messages: user("x") }, ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ modelCode: "rate_limited", retryAfterMs: 40_000 });
    expect(spent.calls.map((c) => c.model)).toEqual(["a"]);
  });

  it("shares a quota bucket across agents and prefers a free model over waiting", async () => {
    const shared = { bucket: "fake:free", perMinute: 1 };
    const provider = fakeProvider(
      "fake",
      { free: say("free"), paid: say("paid") },
      { limits: (model) => (model === "free" ? [shared] : []) },
    );
    const g = gateway([provider]);
    const other: TenantContext = { workspaceId: asId("ws_2"), userId: asId("usr_2") };
    expect((await g.generate({ tier: "fast", messages: user("x") }, ctx)).model).toBe("free");
    const second = await g.generate({ tier: "fast", messages: user("x") }, other);
    expect(second.model).toBe("paid");
    expect(second.attempts[0]).toMatchObject({ model: "free", code: "capacity" });
  });

  it("opens the breaker after repeated failures and skips the model", async () => {
    const provider = fakeProvider("fake", { flaky: fail(500), up: say("ok") });
    const g = gateway([provider]);
    for (let i = 0; i < 3; i++) await g.generate({ tier: "fast", messages: user("x") }, ctx);
    const response = await g.generate({ tier: "fast", messages: user("x") }, ctx);
    expect(response.attempts[0]?.message).toMatch(/failing recently/);
    expect(provider.calls.filter((c) => c.model === "flaky")).toHaveLength(3);
  });

  it("uses environment and workspace tier overrides, across providers", async () => {
    const primary = fakeProvider("one", { a: say("from one") });
    const second = fakeProvider("two", { b: say("from two") });
    const g = gateway([primary, second], {
      tiers: { strong: [{ provider: "two", model: "b" }] },
      workspaceTiers: async () => ({ fast: [{ provider: "two", model: "b" }] }),
    });
    expect((await g.generate({ tier: "standard", messages: user("x") }, ctx)).provider).toBe("one");
    expect((await g.generate({ tier: "strong", messages: user("x") }, ctx)).provider).toBe("two");
    expect((await g.generate({ tier: "fast", messages: user("x") }, ctx)).provider).toBe("two");
  });

  it("budgets context for the smallest window in the chain", async () => {
    const details = (id: string, contextWindow: number): ModelDetails => ({
      id,
      contextWindow,
      maxOutputTokens: 1_000,
      supportsTools: true,
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    const provider = fakeProvider(
      "fake",
      { big: say("x"), small: say("y") },
      {
        details: [details("big", 262_144), details("small", 32_768)],
      },
    );
    expect(await gateway([provider]).modelFor("fast", ctx)).toEqual({
      provider: "fake",
      id: "big",
      contextWindow: 32_768,
      maxOutputTokens: 1_000,
      vision: false,
    });
  });

  // Images (DT.10): only models that read them get a request with them.
  const looks = (id: string, supportsImages: boolean): ModelDetails => ({
    id,
    contextWindow: 32_000,
    maxOutputTokens: 1_000,
    supportsTools: true,
    supportsImages,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
  });
  const screenshot = [
    {
      role: "user" as const,
      content: "What is on the screen?",
      images: [{ data: "iVBORw0KGgo=", mediaType: "image/png" as const }],
    },
  ];

  it("sends a request with images only to models that read them", async () => {
    const provider = fakeProvider(
      "fake",
      { text: say("blind"), sees: say("a window") },
      { details: [looks("text", false), looks("sees", true)] },
    );
    const g = gateway([provider]);
    const answer = await g.generate({ tier: "fast", messages: screenshot }, ctx);
    expect(answer.model).toBe("sees");
    expect(provider.calls.map((c) => c.model)).toEqual(["sees"]);
    // The image travels as an image part after the text.
    const sent = provider.calls[0]?.options.prompt.at(-1);
    expect(sent).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "What is on the screen?" },
        { type: "file", mediaType: "image/png" },
      ],
    });
    // Text-only requests still go down the tier as before.
    expect((await g.generate({ tier: "fast", messages: user("hi") }, ctx)).model).toBe("text");
    expect((await g.modelFor("fast", ctx)).vision).toBe(true);
  });

  it("falls back to the vision chain when the tier's models can't read images", async () => {
    const provider = fakeProvider(
      "fake",
      { text: say("blind"), eyes: say("I see a dock") },
      {
        tiers: { fast: ["text"], standard: ["text"], strong: ["text"] },
        details: [looks("text", false), looks("eyes", true)],
      },
    );
    const withVision = gateway([provider], { vision: [{ provider: "fake", model: "eyes" }] });
    expect((await withVision.generate({ tier: "fast", messages: screenshot }, ctx)).model).toBe(
      "eyes",
    );
    expect((await withVision.modelFor("fast", ctx)).vision).toBe(true);

    // The vision chain is ranked for pointing at a screen: it goes first.
    const both = fakeProvider(
      "fake",
      { sees: say("tier"), eyes: say("vision") },
      { details: [looks("sees", true), looks("eyes", true)] },
    );
    const ranked = gateway([both], { vision: [{ provider: "fake", model: "eyes" }] });
    expect((await ranked.generate({ tier: "fast", messages: screenshot }, ctx)).model).toBe("eyes");

    const without = gateway([provider]);
    expect((await without.modelFor("fast", ctx)).vision).toBe(false);
    await expect(
      without.generate({ tier: "fast", messages: screenshot }, ctx),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("OpenRouter adapter", () => {
  const catalog = {
    data: [
      {
        id: "vendor/model:free",
        context_length: 131_072,
        pricing: { prompt: "0", completion: "0" },
        top_provider: { max_completion_tokens: 8_192 },
        supported_parameters: ["tools", "temperature"],
        architecture: { input_modalities: ["text", "image"] },
      },
      {
        id: "vendor/paid",
        context_length: 200_000,
        pricing: { prompt: "0.000003", completion: "0.000015" },
        supported_parameters: [],
      },
    ],
  };

  function fakeOpenRouter() {
    const requests: { url: string; headers: Headers; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/models")) return Response.json(catalog);
      return Response.json({
        id: "gen-1",
        object: "chat.completion",
        created: 1,
        model: "vendor/model:free",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":"pgvector"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135 },
      });
    };
    return { requests, fetchImpl };
  }

  it("reads the catalog: windows, prices, tool and image support", async () => {
    const { fetchImpl } = fakeOpenRouter();
    const models = await createOpenRouterProvider({ fetch: fetchImpl }).listModels();
    expect(models).toEqual([
      {
        id: "vendor/model:free",
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsImages: true,
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
      {
        id: "vendor/paid",
        contextWindow: 200_000,
        maxOutputTokens: undefined,
        supportsTools: false,
        supportsImages: false,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      },
    ]);
  });

  it("puts free models in the shared free-tier queue", () => {
    const provider = createOpenRouterProvider({ freeRequestsPerDay: 50 });
    expect(provider.rateLimits("vendor/model:free")).toEqual([
      { bucket: "openrouter:free", perMinute: 20, perDay: 50 },
    ]);
    expect(provider.rateLimits("vendor/paid")).toEqual([]);
  });

  it("serves a tool call end to end with the workspace's key", async () => {
    const { requests, fetchImpl } = fakeOpenRouter();
    const provider = createOpenRouterProvider({
      fetch: fetchImpl,
      defaultTiers: { fast: ["vendor/model:free"], standard: [], strong: [] },
    });
    const response = await gateway([provider]).generate(
      { tier: "fast", messages: user("Search pgvector"), tools: [webSearch] },
      ctx,
    );
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "web.search", args: { query: "pgvector" } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 15, costUsd: 0 });

    const chat = requests.find((r) => r.url.endsWith("/chat/completions"));
    expect(chat?.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.stringify(chat?.body)).toContain('"name":"web_search"');
  });
});
