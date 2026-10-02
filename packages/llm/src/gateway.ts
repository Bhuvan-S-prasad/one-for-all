import type {
  LLMAttempt,
  LLMGateway,
  LLMRequest,
  LLMResponse,
  ModelErrorCode,
  ModelInfo,
  ModelTier,
  TenantContext,
} from "@ofa/core";
import { generateText } from "ai";
import { createCircuitBreaker, type CircuitBreaker } from "./breaker";
import { createModelCatalog, type ModelCatalog } from "./catalog";
import { classifyModelError, ModelError, type ClassifiedError } from "./errors";
import { ToolNames, toModelMessages, toToolSet } from "./messages";
import type { ModelDetails, ModelProvider, RateLimit } from "./provider";
import { createMemoryRateLimiter, systemClock, type Clock, type RateLimiter } from "./queue";
import {
  formatModelRef,
  resolveTiers,
  type ModelRef,
  type TierMap,
  type TierOverrides,
} from "./tiers";

// The model gateway (ADR-0008, ADR-0022): the one implementation of
// `LLMGateway`. It knows tiers, quotas, fallback, breakers and cost, and
// nothing about any particular provider; those come in as `ModelProvider`s.

/** Used when the catalog has no entry for a model (offline, or a new model). */
const FALLBACK_CONTEXT_WINDOW = 8_192;

export interface ModelGatewayOptions {
  /** Every provider that may serve calls. The first is the primary: its defaults fill the tiers. */
  readonly providers: readonly [ModelProvider, ...ModelProvider[]];
  /**
   * The API key for a provider in this workspace, decrypted only for the call.
   * Undefined when none is set; the call then fails with `auth` if the provider needs one.
   */
  apiKey(ctx: TenantContext, provider: ModelProvider): Promise<string | undefined>;
  /** Tier overrides from the environment. */
  readonly tiers?: TierOverrides;
  /** Per-workspace tier overrides (Settings, later), laid over `tiers`. */
  workspaceTiers?(ctx: TenantContext): Promise<TierOverrides>;
  /** How long a call may wait in the quota queue before giving up. Default 20 s. */
  readonly maxQueueWaitMs?: number;
  /** Per-call timeout. Default 120 s. */
  readonly timeoutMs?: number;
  readonly limiter?: RateLimiter;
  readonly breaker?: CircuitBreaker;
  readonly catalog?: ModelCatalog;
  readonly clock?: Clock;
}

interface Candidate {
  readonly ref: ModelRef;
  readonly key: string;
  readonly provider: ModelProvider;
  readonly limits: readonly RateLimit[];
}

/** Breakers count only failures that say the model is down. */
const BREAKER_FAILURES: readonly ModelErrorCode[] = ["unavailable", "timeout", "unknown"];

function costUsd(details: ModelDetails | undefined, input: number, output: number): number {
  if (!details) return 0;
  return (input * details.pricing.inputPerMTok + output * details.pricing.outputPerMTok) / 1e6;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Replace the API key in any text that might reach a log or run event (hard rule 4). */
function scrub(text: string, apiKey: string | undefined): string {
  return apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[REDACTED]") : text;
}

/** Pick the error to report when every model in the chain failed. */
function finalError(attempts: readonly LLMAttempt[], retryAfter: number[]): ModelError {
  const has = (code: ModelErrorCode) => attempts.some((a) => a.code === code);
  const summary = attempts.map((a) => `${a.provider}:${a.model}: ${a.message}`).join("; ");
  if (has("auth")) {
    const provider = attempts.find((a) => a.code === "auth")?.provider ?? "the provider";
    return new ModelError("auth", `The API key for ${provider} is missing or was refused`, {
      attempts,
    });
  }
  if (has("capacity") || has("rate_limited")) {
    return new ModelError(has("rate_limited") ? "rate_limited" : "capacity", summary, {
      attempts,
      retryAfterMs: retryAfter.length > 0 ? Math.min(...retryAfter) : 60_000,
    });
  }
  const last = attempts[attempts.length - 1];
  return new ModelError(last?.code ?? "unavailable", summary || "No model answered", { attempts });
}

export function createModelGateway(options: ModelGatewayOptions): LLMGateway {
  const providers = new Map(options.providers.map((p) => [p.id, p]));
  const primary = options.providers[0];
  const clock = options.clock ?? systemClock;
  const limiter = options.limiter ?? createMemoryRateLimiter(clock);
  const breaker = options.breaker ?? createCircuitBreaker({ now: clock.now });
  const catalog = options.catalog ?? createModelCatalog({ now: clock.now });
  const maxQueueWaitMs = options.maxQueueWaitMs ?? 20_000;
  const timeoutMs = options.timeoutMs ?? 120_000;

  async function tiersFor(ctx: TenantContext): Promise<TierMap> {
    const workspace = (await options.workspaceTiers?.(ctx)) ?? {};
    return resolveTiers(primary, options.tiers ?? {}, workspace);
  }

  async function chainFor(tier: ModelTier, ctx: TenantContext): Promise<Candidate[]> {
    const chain = (await tiersFor(ctx))[tier];
    const candidates = chain.flatMap((ref): Candidate[] => {
      const provider = providers.get(ref.provider);
      if (!provider) return [];
      const key = formatModelRef(ref);
      // A per-model bucket with no limits, so a 429 can pause just this model.
      return [{ ref, key, provider, limits: [...provider.rateLimits(ref.model), { bucket: key }] }];
    });
    if (candidates.length === 0) {
      throw new ModelError("bad_request", `No models are configured for the ${tier} tier`);
    }
    return candidates;
  }

  async function call(
    candidate: Candidate,
    request: LLMRequest,
    apiKey: string | undefined,
  ): Promise<Omit<LLMResponse, "attempts">> {
    const { ref, provider } = candidate;
    const details = await catalog.get(provider, ref.model);
    const names = new ToolNames((request.tools ?? []).map((t) => t.name));
    const maxOutputTokens =
      request.maxOutputTokens !== undefined && details?.maxOutputTokens !== undefined
        ? Math.min(request.maxOutputTokens, details.maxOutputTokens)
        : request.maxOutputTokens;

    const started = clock.now();
    const result = await generateText({
      model: provider.languageModel(ref.model, { apiKey }),
      messages: toModelMessages(request.messages, names),
      allowSystemInMessages: true,
      tools: request.tools?.length ? toToolSet(request.tools, names) : undefined,
      maxOutputTokens,
      temperature: request.temperature,
      // Retries and fallback are ours: one attempt per model, then the next model.
      maxRetries: 0,
      timeout: timeoutMs,
    });

    const toolCalls = result.toolCalls.map((toolCall) => {
      const name = names.original(toolCall.toolName);
      const invalid =
        name === undefined
          ? `Unknown tool: ${toolCall.toolName}`
          : "invalid" in toolCall && toolCall.invalid
            ? `Invalid arguments: ${errorText(toolCall.error)}`
            : undefined;
      return {
        id: toolCall.toolCallId,
        name: name ?? toolCall.toolName,
        args: toolCall.input,
        ...(invalid ? { invalid: scrub(invalid, apiKey) } : {}),
      };
    });
    if (!result.text.trim() && toolCalls.length === 0 && result.finishReason !== "length") {
      // Some free models answer with nothing at all. Treat it as a failure so
      // the next model in the chain gets a chance.
      throw new ModelError("unknown", "The model returned an empty response");
    }

    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    return {
      text: result.text,
      toolCalls,
      usage: { inputTokens, outputTokens, costUsd: costUsd(details, inputTokens, outputTokens) },
      provider: provider.id,
      model: ref.model,
      finishReason: result.finishReason,
      durationMs: clock.now() - started,
    };
  }

  return {
    async generate(request, ctx) {
      const candidates = await chainFor(request.tier, ctx);
      const attempts: LLMAttempt[] = [];
      const retryAfter: number[] = [];
      const keys = new Map<string, string | undefined>();
      const skipProviders = new Set<string>();

      const record = (candidate: Candidate, failure: ClassifiedError, apiKey?: string) => {
        attempts.push({
          provider: candidate.provider.id,
          model: candidate.ref.model,
          code: failure.code,
          message: scrub(failure.message, apiKey),
        });
        if (failure.retryAfterMs !== undefined) retryAfter.push(failure.retryAfterMs);
      };

      for (const [index, candidate] of candidates.entries()) {
        const { provider, key: modelKey, limits } = candidate;
        if (skipProviders.has(provider.id)) continue;
        if (breaker.isOpen(modelKey)) {
          record(candidate, { code: "unavailable", message: "Skipped: failing recently" });
          continue;
        }

        if (!keys.has(provider.id)) keys.set(provider.id, await options.apiKey(ctx, provider));
        const apiKey = keys.get(provider.id);
        if (provider.requiresApiKey && !apiKey) {
          record(candidate, { code: "auth", message: `No API key set for ${provider.label}` });
          skipProviders.add(provider.id);
          continue;
        }

        // Prefer a later model that is free right now over waiting for this one.
        const laterIsFree = candidates
          .slice(index + 1)
          .some(
            (c) =>
              !skipProviders.has(c.provider.id) &&
              !breaker.isOpen(c.key) &&
              limiter.waitTime(c.limits) === 0,
          );
        try {
          await limiter.acquire(limits, { maxWaitMs: laterIsFree ? 0 : maxQueueWaitMs });
        } catch (error) {
          record(candidate, classifyModelError(error, clock.now()));
          continue;
        }

        if (!breaker.canTry(modelKey)) {
          record(candidate, { code: "unavailable", message: "Skipped: failing recently" });
          continue;
        }
        try {
          const response = await call(candidate, request, apiKey);
          breaker.success(modelKey);
          return { ...response, attempts };
        } catch (error) {
          const failure = classifyModelError(error, clock.now());
          record(candidate, failure, apiKey);
          if (BREAKER_FAILURES.includes(failure.code)) breaker.failure(modelKey);
          else breaker.success(modelKey); // It answered; it is up.
          if (failure.code === "rate_limited") {
            // Pause the shared quota only when the account's quota is spent;
            // a busy upstream for one model pauses just that model.
            const until = clock.now() + (failure.retryAfterMs ?? 60_000);
            const buckets = failure.quotaExhausted ? limits.map((l) => l.bucket) : [modelKey];
            for (const bucket of buckets) limiter.pause(bucket, until);
          }
          if (failure.code === "auth") skipProviders.add(provider.id);
        }
      }
      throw finalError(attempts, retryAfter);
    },

    async modelFor(tier, ctx): Promise<ModelInfo> {
      const all = await chainFor(tier, ctx);
      const usable = all.filter((c) => !breaker.isOpen(c.key));
      const chain = usable.length > 0 ? usable : all;
      const details = await Promise.all(chain.map((c) => catalog.get(c.provider, c.ref.model)));
      const first = chain[0] as Candidate;
      // Budget for the smallest window in the chain: a fallback model must fit
      // the same prompt. Models without metadata do not count.
      const windows = details.map((d) => d?.contextWindow ?? 0).filter((w) => w > 0);
      return {
        provider: first.provider.id,
        id: first.ref.model,
        contextWindow: windows.length > 0 ? Math.min(...windows) : FALLBACK_CONTEXT_WINDOW,
        maxOutputTokens: details[0]?.maxOutputTokens,
      };
    },
  };
}
