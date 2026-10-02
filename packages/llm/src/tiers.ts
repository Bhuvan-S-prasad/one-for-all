import { MODEL_TIERS, type ModelTier } from "@ofa/core";
import type { ModelProvider } from "./provider";

/** One model at one provider. Written `provider:model` in config. */
export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

/** Model chain per tier, best first. */
export type TierMap = Readonly<Record<ModelTier, readonly ModelRef[]>>;
export type TierOverrides = Readonly<Partial<Record<ModelTier, readonly ModelRef[]>>>;

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

/**
 * Parse `openrouter:qwen/qwen3.8-27b:free`, or a bare model ID for the
 * primary provider. Model IDs may contain colons themselves, so the prefix
 * counts as a provider only if one with that ID is registered.
 */
export function parseModelRef(
  value: string,
  providerIds: readonly string[],
  primary: string,
): ModelRef {
  const trimmed = value.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0 && providerIds.includes(trimmed.slice(0, colon))) {
    return { provider: trimmed.slice(0, colon), model: trimmed.slice(colon + 1) };
  }
  return { provider: primary, model: trimmed };
}

/** A comma-separated list, e.g. from `LLM_MODELS_FAST`. Empty input gives an empty list. */
export function parseModelList(
  value: string | undefined,
  providerIds: readonly string[],
  primary: string,
): ModelRef[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseModelRef(item, providerIds, primary));
}

/** The primary provider's defaults, with any overrides laid over them per tier. */
export function resolveTiers(primary: ModelProvider, ...layers: TierOverrides[]): TierMap {
  const defaults = (tier: ModelTier) =>
    primary.defaultTiers[tier].map((model) => ({ provider: primary.id, model }));
  const tiers: Record<ModelTier, readonly ModelRef[]> = {
    fast: defaults("fast"),
    standard: defaults("standard"),
    strong: defaults("strong"),
  };
  for (const layer of layers) {
    for (const tier of MODEL_TIERS) {
      const chain = layer[tier];
      if (chain && chain.length > 0) tiers[tier] = chain;
    }
  }
  return tiers;
}
