# ADR-0022: Model providers are replaceable, one file each

- **Status:** Accepted
- **Date:** 2026-10-01
- **Area:** Runtime
- **Related:** ADR-0008 (amends), ADR-0012 (clarifies), ARCHITECTURE.md §3 (L6), §4, §11

## Context

ADR-0008 put every model call behind `LLMGateway` and chose OpenRouter. The owner wants to be able to move to another provider (Anthropic, OpenAI, a local server) later by changing one module, not every place that calls a model.

Three things vary by provider beyond the API itself:

- **Quotas.** Free OpenRouter models share 20 requests a minute and 1,000 a day per account; paid models have none we need to enforce.
- **Model metadata.** Context windows, prices and tool support come from each provider's own catalog.
- **Defaults.** Which models suit the `fast`, `standard` and `strong` tiers depends on what the provider offers.

Free models also change often, so tier mappings must be easy to override without code.

## Decision

Split the gateway into a provider-neutral core and one adapter file per provider.

- **The provider contract.** `ModelProvider` in `packages/llm/src/provider.ts` has: `id`, `label`, `requiresApiKey`, `defaultTiers`, `languageModel(modelId, { apiKey })` (an AI SDK model), `listModels()` (windows, prices, tool support) and `rateLimits(modelId)` (shared quota buckets).
- **One file per provider.** `packages/llm/src/providers/openrouter.ts` is the only code that knows OpenRouter exists. Anthropic, OpenAI or Ollama would each be one more file of the same shape, built on the matching AI SDK provider package.
- **A neutral gateway.** `createModelGateway` does tiers, the shared quota queue, fallback, per-model circuit breakers, error classification and metering for any provider. The harness and everything above it see only `LLMGateway` and a tier name.
- **Selection in the composition root.** `apps/*/src/container.ts` holds the list of available providers; `LLM_PROVIDER` picks one. Switching provider is one setting. Adding one is a new file, an export, and one line in that list.
- **Model references** are written `provider:model` (a bare model ID means the primary provider). Tier chains are resolved as provider defaults, then `LLM_MODELS_FAST|STANDARD|STRONG`, then per-workspace settings, so chains may mix providers.
- **Keys.** Each workspace saves its key in the vault as `llm.<provider>.api_key`; `LLM_API_KEY` is a fallback for development and single-user installs. The gateway asks for the key per call and scrubs it from every error message it records.
- **Provider-neutral errors.** Failures are mapped to `MODEL_ERROR_CODES` (`rate_limited`, `capacity`, `auth`, `bad_request`, `context_length`, `unavailable`, `timeout`) from HTTP status and headers, so fallback and retry rules never mention a provider. A 429 pauses only the model that received it, unless `X-RateLimit-Remaining: 0` shows the account quota is spent; OpenRouter also answers 429 when a single free model's host is busy, and pausing every free model for that was the first bug the tier spike found. Likewise only 401 (bad key) and 402 (no credit) count as `auth` and stop the provider; a 403 refuses one model (OpenRouter reserves some free models for listed apps), so the chain moves on.

This amends ADR-0008 in two places: circuit breakers are **per model**, not per provider (on OpenRouter one free model can be down while others work), and Ollama becomes "a provider file when needed" rather than part of the first build.

It clarifies ADR-0012: a model provider's API key is a credential that is decrypted where it is used, which is the model gateway, not the tool executor. It still never enters a prompt, log, trace or run event.

## Alternatives considered

- **The AI SDK's provider registry alone** (`createProviderRegistry`): swaps the API, but carries no quotas, catalog or tier defaults, and callers would pass provider-prefixed model strings, spreading provider knowledge upward.
- **A hosted gateway** (Vercel AI Gateway, OpenRouter itself as the abstraction): another account and network hop, and no route to a local model.
- **A LiteLLM proxy container:** a provider-neutral HTTP API, but one more container (Python, ~300 MB) against a 3 GB RAM budget, and quotas would still need handling in our code.
- **OpenAI-compatible APIs only:** covers many providers with one adapter, but loses native features (Anthropic prompt caching, extended thinking) and depends on each vendor's compatibility layer.

## Consequences

- **Positive:** a provider change touches one file and one setting; nothing that calls a model changes. Fallback chains can span providers, e.g. a local model behind a hosted one.
- **Positive:** the gateway's behaviour is tested once against fake providers; each adapter needs only a small test against a fake HTTP server.
- **Negative:** quota rules are provider knowledge we maintain by hand (OpenRouter's free-tier limits are in its adapter). A real 429 still pauses the queue, so a stale number costs a retry, not a failure.
- **Negative:** the quota queue lives in process memory, which is right for the single-process self-host bundle. Cloud mode, with several workers, needs a shared `RateLimiter` (Postgres or Valkey).
- **Follow-up:** Settings screen for the key (M2.21); per-workspace tier overrides; embeddings through the same contract when memory needs them (M2.16), with `memory.embedding_model` recording which model made each vector.
