# ADR-0024: Agents learn after the run, not during it

- **Status:** Accepted
- **Date:** 2026-10-02
- **Area:** Runtime
- **Related:** ADR-0006 (Inngest), ADR-0014 (run log), ADR-0015 (idempotency), ARCHITECTURE.md §6.2, §8

## Context

After an answered run, a fast model reads the exchange and picks out facts worth keeping (ARCHITECTURE.md §8). The first build ran this extraction as the last step of the agent's own run, before `run.ended`.

The M2 browser check showed the cost. On a free fast-tier model, extraction took 76 seconds after the reply had already been posted. For that whole time:

- the run stayed "Running" and the familiar kept "thinking", though the person already had their answer;
- the agent's next message waited, because runs are limited to one at a time per agent (`concurrency: 1` keyed by agent).

Free models are often slow, so this would be the normal case, not a rare one.

## Decision

**Learning is a separate durable function that starts when a run succeeds.**

- **The run ends at the reply.** `runAgent` posts the reply, writes `run.ended`, and returns `learn: true` when the run gave a final answer, posted a message, and the agent has memory.
- **An event hands over.** The `agent-run` function then sends `agent/run.succeeded` (`runSucceededEventSchema`: tenant, agent, run, thread and reply message IDs), with an idempotent event ID per run.
- **A function of its own.** `agent-learn` runs `learnFromRun` in one step. It reloads the run, the agent and the thread up to the reply, so a message sent in the meantime is not mixed in. Its concurrency is one at a time per workspace, separate from the agents' own limit, so learning never delays an answer. It retries twice; a failure never reaches the person, because learning is a bonus.
- **The run log stays the record.** A closed log (ADR-0014) normally accepts only `run.ended`, so an in-flight step cannot add events after Stop. One exception: a run that **succeeded** also accepts events whose key starts with `learn-` (`LEARN_EVENT_PREFIX`). The learning model call (`learn-model`) and each memory written (`learn-memory-N`) therefore still appear in that run's log, after `run.ended`. Activity labels the call "Looked back for things to remember".
- **Costs stay with the run.** The learning call's tokens and cost are added to the run's usage totals.
- **Tainted runs** still store what they learn as unverified (§8, §10.3).

## Alternatives considered

- **Keep extraction in the run, with a short timeout:** caps the delay but still holds the agent's turn for every reply, and a cut-off call learns nothing.
- **Write `run.ended` first, then extract in the same function:** the run looks finished, but the function still holds the agent's concurrency slot, so the next message still waits.
- **Log learning under a separate run:** keeps the closed-log rule absolute, but splits one exchange across two records and adds a fake run to Activity and usage.
- **Nightly batch extraction only:** cheapest, but facts from today's conversations would not help until tomorrow.

## Consequences

- **Positive:** the agent is free about three seconds after replying, whatever the speed of the fast-tier model.
- **Positive:** learning cannot fail or delay a run, and runs one at a time per workspace, which spares the shared free quota.
- **Negative:** a fact from one message may not yet be in memory when the very next message starts. The thread history still carries it, so the agent rarely notices.
- **Negative:** the closed-log rule has one exception, guarded by the run's status and a key prefix. The store, the in-memory test runtime and an integration test enforce it.
- **Follow-up:** episode summaries and nightly consolidation (§8) can hang off the same event.
