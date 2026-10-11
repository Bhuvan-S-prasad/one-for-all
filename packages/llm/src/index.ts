export { createCircuitBreaker, type BreakerOptions, type CircuitBreaker } from "./breaker";
export { createModelCatalog, type CatalogOptions, type ModelCatalog } from "./catalog";
export {
  classifyModelError,
  ModelError,
  retryAfterFromHeaders,
  type ClassifiedError,
} from "./errors";
export { createModelGateway, type ModelGatewayOptions } from "./gateway";
export type { ModelDetails, ModelProvider, RateLimit, TierModels } from "./provider";
export {
  createMemoryRateLimiter,
  systemClock,
  type AcquireOptions,
  type Clock,
  type RateLimiter,
} from "./queue";
export {
  formatModelRef,
  parseModelList,
  parseModelRef,
  resolveTiers,
  type ModelRef,
  type TierMap,
  type TierOverrides,
} from "./tiers";

// Providers. Adding one: a file in providers/, an export here, and a line in
// the composition root's provider list (ADR-0022).
export {
  createOpenRouterProvider,
  isFreeOpenRouterModel,
  OPENROUTER_DEFAULT_TIERS,
  OPENROUTER_DEFAULT_VISION,
  type OpenRouterOptions,
} from "./providers/openrouter";
