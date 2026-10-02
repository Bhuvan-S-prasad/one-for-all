import type { ModelTier } from "@ofa/core";
import type { LanguageModel } from "ai";

// The provider contract (ADR-0022). Everything that differs between OpenRouter,
// Anthropic, OpenAI, Ollama and the rest sits behind this interface, one file
// per provider in `providers/`. The gateway (tiers, queue, fallback, breaker,
// metering) never names a provider.
//
// To add a provider: write `providers/<name>.ts` that returns a ModelProvider,
// export it from the package, and register it in the composition root. Then
// set LLM_PROVIDER. Nothing else changes.

/** What the gateway needs to know about one model. */
export interface ModelDetails {
  /** The provider's own model ID, e.g. `meta-llama/llama-3.3-70b-instruct:free`. */
  readonly id: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | undefined;
  readonly supportsTools: boolean;
  /** US dollars per million tokens; zero for free models. */
  readonly pricing: { readonly inputPerMTok: number; readonly outputPerMTok: number };
}

/**
 * A quota the provider enforces. Models that share a bucket share one queue,
 * e.g. every free model on OpenRouter counts against the same 20 per minute.
 */
export interface RateLimit {
  readonly bucket: string;
  readonly perMinute?: number;
  readonly perDay?: number;
}

/** Model IDs per tier, best first. The gateway falls back along the list. */
export type TierModels = Readonly<Record<ModelTier, readonly string[]>>;

export interface ModelProvider {
  /** Short, stable ID used in config and secret names: `openrouter`. */
  readonly id: string;
  /** Shown to people: "OpenRouter". */
  readonly label: string;
  /** False for local providers such as Ollama. */
  readonly requiresApiKey: boolean;
  /** Models per tier until the workspace or environment sets its own. */
  readonly defaultTiers: TierModels;

  /**
   * An AI SDK language model for one call. The key is passed per call because
   * each workspace brings its own and can change it in Settings.
   */
  languageModel(modelId: string, options: { readonly apiKey: string | undefined }): LanguageModel;

  /** Metadata for the models this provider offers. The gateway caches it. */
  listModels(): Promise<ModelDetails[]>;

  /** Quotas that apply to a model; an empty list means none known. */
  rateLimits(modelId: string): readonly RateLimit[];
}
