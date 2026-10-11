import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { ModelDetails, ModelProvider, RateLimit, TierModels } from "../provider";

// OpenRouter: one key, hundreds of models, free tiers included. The only
// file that knows OpenRouter exists (ADR-0022).

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Chosen by the tier spike on 2026-10-02 (M2.05, ARCHITECTURE.md §19): free
 * models that called tools reliably, best first. Each chain mixes upstream
 * hosts (NVIDIA, Cohere, dots, inclusionAI) so one host's outage or rate
 * limit leaves a fallback. Free models come and go: override with
 * LLM_MODELS_* or per workspace, and re-run `pnpm --filter @ofa/llm spike`.
 */
export const OPENROUTER_DEFAULT_TIERS: TierModels = {
  fast: [
    "nvidia/nemotron-3.5-lightning:free",
    "cohere/north-mini-code:free",
    "inclusionai/ling-3.0-flash-sante:free",
  ],
  standard: [
    "dots-studio/dots-3-note-preview:free",
    "cohere/north-mini-code:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
  ],
  strong: [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "dots-studio/dots-3-note-preview:free",
  ],
};

/**
 * Free models that read images and call tools, best first (DT.10): they
 * serve requests with images (screenshots) when a tier's own models can't.
 * Chosen by `pnpm --filter @ofa/llm spike:vision`; override with
 * LLM_MODELS_VISION.
 */
export const OPENROUTER_DEFAULT_VISION: readonly string[] = [
  // Spike on 2026-10-11 (DT.10), clicks on a real desktop screenshot in
  // fractions of the screen: 4 of 5, then 2, 2 and 2 (one 2 px off); all six
  // free vision models read the screen right.
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "dots-studio/dots-3-note-preview:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
];

export interface OpenRouterOptions {
  readonly baseURL?: string;
  /** Free models share one quota per account: 20 requests a minute. */
  readonly freeRequestsPerMinute?: number;
  /**
   * Free requests a day: 1,000 once the account has bought $10 of credit,
   * 50 before that. A real 429 from OpenRouter pauses the queue either way.
   */
  readonly freeRequestsPerDay?: number;
  readonly defaultTiers?: TierModels;
  readonly defaultVision?: readonly string[];
  /** For tests. */
  readonly fetch?: typeof fetch;
}

// Only the fields we use; OpenRouter adds fields freely.
const catalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      context_length: z.number().nullish(),
      pricing: z.object({ prompt: z.string(), completion: z.string() }).partial().nullish(),
      top_provider: z.object({ max_completion_tokens: z.number().nullish() }).nullish(),
      supported_parameters: z.array(z.string()).nullish(),
      architecture: z.object({ input_modalities: z.array(z.string()).nullish() }).nullish(),
    }),
  ),
});

/** OpenRouter prices are US dollars per token, as strings. */
function perMillion(price: string | undefined): number {
  const value = Number(price ?? 0);
  return Number.isFinite(value) && value > 0 ? value * 1_000_000 : 0;
}

export function isFreeOpenRouterModel(modelId: string): boolean {
  return modelId.endsWith(":free");
}

export function createOpenRouterProvider(options: OpenRouterOptions = {}): ModelProvider {
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const freeLimit: RateLimit = {
    bucket: "openrouter:free",
    perMinute: options.freeRequestsPerMinute ?? 20,
    perDay: options.freeRequestsPerDay ?? 1_000,
  };

  return {
    id: "openrouter",
    label: "OpenRouter",
    requiresApiKey: true,
    defaultTiers: options.defaultTiers ?? OPENROUTER_DEFAULT_TIERS,
    defaultVision: options.defaultVision ?? OPENROUTER_DEFAULT_VISION,

    languageModel(modelId, { apiKey, reasoning }) {
      // `apiKey` is always passed: without it the SDK would read
      // OPENROUTER_API_KEY from the environment, bypassing the vault.
      const openrouter = createOpenRouter({
        apiKey: apiKey ?? "",
        baseURL,
        compatibility: "strict",
        fetch: options.fetch,
      });
      // OpenRouter passes the effort on to models that reason, and drops it for others.
      return reasoning
        ? openrouter.chat(modelId, { reasoning: { effort: reasoning } })
        : openrouter.languageModel(modelId);
    },

    async listModels() {
      // The model list is public; no key needed.
      const response = await fetchImpl(`${baseURL}/models`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`OpenRouter model list: HTTP ${response.status}`);
      const catalog = catalogSchema.parse(await response.json());
      return catalog.data.map((model): ModelDetails => ({
        id: model.id,
        contextWindow: model.context_length ?? 0,
        maxOutputTokens: model.top_provider?.max_completion_tokens ?? undefined,
        supportsTools: model.supported_parameters?.includes("tools") ?? false,
        supportsImages: model.architecture?.input_modalities?.includes("image") ?? false,
        pricing: {
          inputPerMTok: perMillion(model.pricing?.prompt),
          outputPerMTok: perMillion(model.pricing?.completion),
        },
      }));
    },

    rateLimits(modelId) {
      return isFreeOpenRouterModel(modelId) ? [freeLimit] : [];
    },
  };
}
