# ADR-0015: Side effects happen exactly once

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Runtime
- **Related:** ADR-0006, ADR-0014, ARCHITECTURE.md §11

## Context

Durable steps retry. If a worker crashes after sending an email but before recording the result, a naive retry sends it again. Duplicate emails, payments or posts are among the most damaging agent failures.

## Decision

- Every tool call gets an idempotency key: `runId:step`.
- The call is recorded as `in_flight` in `tool_call` before execution and `done` after.
- On retry, an `in_flight` call is verified before re-executing (for example, by checking the Sent folder).
- APIs that accept idempotency keys receive ours.

## Alternatives considered

- **Relying on step retries alone:** safe only for idempotent tools.

## Consequences

- **Positive:** retries cannot duplicate external actions.
- **Negative:** non-idempotent tools need a verify function.
- **Follow-up:** a `verify` hook in the tool definition interface.
