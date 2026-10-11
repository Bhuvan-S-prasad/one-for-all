# ADR-0014: The run is the unit of truth

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Runtime
- **Related:** ADR-0006, ADR-0015, ADR-0019, ARCHITECTURE.md §2, §12

## Context

Several features need to know what an agent did: the live Activity view, tracing, evals, the audit trail, crash recovery, and turning bad runs into regression tests. Building a separate log for each would duplicate data and let the copies disagree.

## Decision

Every agent execution is a `run` with an append-only `run_event` log recording model calls, tool calls, policy verdicts, approvals and errors, in order. All the features above read from this log. Past events are never mutated.

## Alternatives considered

- **Separate logging per concern:** duplicated data that drifts.

## Consequences

- **Positive:** one source of truth; failed runs become eval cases with no extra plumbing.
- **Negative:** storage grows with use.
- **Follow-up:** a scheduled job that summarizes and prunes old run events after a retention period.
