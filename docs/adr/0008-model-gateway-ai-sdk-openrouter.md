# ADR-0008: Model gateway on the AI SDK and OpenRouter

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Runtime
- **Related:** ADR-0001, ADR-0006, ARCHITECTURE.md §3 (L6), §7, §11; amended by ADR-0022 (replaceable providers, per-model breakers)

## Context

The project runs on OpenRouter, with each user supplying their own key. Free models are limited to 20 requests per minute and 1,000 per day (after a one-time $10 credit purchase). Free models differ widely in tool-calling quality and context size. Providers fail and throttle. Budgets need per-run token and cost figures.

## Decision

`packages/llm` implements `LLMGateway` on the Vercel AI SDK with the OpenRouter provider, plus optional Ollama:

- Model tiers (`fast`, `standard`, `strong`) mapped per workspace.
- One shared queue that respects the per-minute limit across all agents.
- A fallback chain per tier and a circuit breaker per provider.
- Token and cost metering per run, feeding budgets and telemetry.
- Context-window sizes read from OpenRouter model metadata for context budgets.

## Alternatives considered

- **Agents calling providers directly:** no shared rate limit, no fallback, no metering.
- **A heavier agent framework:** hides the loop we need to control in the harness.

## Consequences

- **Positive:** tool calling, streaming, structured output and an MCP client from one library; limits and outages handled in one place.
- **Negative:** free-model quality varies, so a model must pass the eval suites before a tier can use it.
- **Follow-up:** tier-qualification evals; a "waiting for model capacity" state in the UI.
