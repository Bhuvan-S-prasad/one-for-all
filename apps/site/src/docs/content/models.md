Every model call goes through one gateway, `packages/llm`. The rest of the system asks for a **tier**, never a model.

## Tiers

| Tier       | Used for                                                         |
| ---------- | ---------------------------------------------------------------- |
| `fast`     | Background work: the learning pass, the nightly tidy-up          |
| `standard` | Most agents                                                      |
| `strong`   | Agents with harder jobs, like a chief of staff writing briefs    |
| vision     | Calls that carry a screenshot go only to models that read images |

Which models fill each tier is configuration (`LLM_MODELS_FAST`, `LLM_MODELS_STANDARD`, `LLM_MODELS_STRONG`, `LLM_MODELS_VISION`): an ordered list per tier, which is also its fallback chain.

## The shared queue

OpenRouter's free models allow **20 requests a minute and 1,000 a day** per user. Every call from every agent waits for a slot in one shared queue, so a busy team never trips the limit.

## When a model fails

- **Fallback.** Each tier is a chain; the gateway prefers a model with a free slot over waiting for a busy one.
- **Circuit breakers.** A model that keeps failing is skipped for a while.
- **Busy, not broken.** A 429 pauses only the model that got it, unless the provider says the account's quota is spent.
- **Waiting, not failing.** When nothing is free, the run waits ("Waiting for the model", with a countdown) instead of failing.

## Replaceable providers

A provider is one file in `packages/llm/src/providers/`, implementing `ModelProvider`, and `LLM_PROVIDER` picks it. OpenRouter is the one in use. No provider SDK is imported anywhere else, and no model is named outside the tier configuration.

## Qualifying a model

Free models change often. Before a model goes into a tier, it runs the eval cases:

```sh
pnpm eval --case team --k 3 --model openrouter:<model id>
```

`--model` puts one model in every tier for the run, and `--k` repeats each case to measure how often it passes every time. A tool-calling check of every free model is `pnpm --filter @ofa/llm spike`.

## Thinking less in the background

Background calls (learning, tidying) ask the model to answer without long reasoning, through a provider-neutral hint. Free models that think aloud otherwise ran past their output limit and answered nothing.
