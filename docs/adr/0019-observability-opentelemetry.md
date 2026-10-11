# ADR-0019: Observability through OpenTelemetry, kept local

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Runtime
- **Related:** ADR-0014, ARCHITECTURE.md §12

## Context

We need traces of every run, model call and tool call to debug agents, measure cost and latency, and feed evals. Traces contain the user's emails, documents and messages. Self-hosters should not have to send that data to a third party, and the hosted version needs a production-grade backend.

## Decision

Instrument with OpenTelemetry in `packages/telemetry`: one trace per run, with spans per model call and tool call carrying latency, tokens, cost, model and prompt version, policy verdict, taint state, retries and errors. Backends:

- Self-host: off by default, or an optional local Phoenix container (Compose profile `observability`).
- Cloud: Langfuse or Grafana.

## Alternatives considered

- **A custom dashboard:** more work, less complete.
- **Sending traces to a hosted service by default:** ships private user data off the machine.

## Consequences

- **Positive:** a standard, swappable backend; private data stays local.
- **Negative:** self-hosters who want trace views run one more container.
- **Follow-up:** span helpers used by the harness middleware; a redaction pass before export.
