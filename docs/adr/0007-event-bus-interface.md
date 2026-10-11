# ADR-0007: Event bus behind an interface

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Runtime
- **Related:** ADR-0001, ADR-0004, ARCHITECTURE.md §4

## Context

Clients need live updates (run events, approvals, presence) pushed over WebSocket. The home bundle should stay small, while a hosted version needs fan-out across many API replicas.

## Decision

Define `EventBus` in `packages/core` with two adapters in `packages/events`:

- Self-host: Postgres `LISTEN/NOTIFY`.
- Cloud: Valkey pub/sub.

Events carry IDs and small payloads; subscribers fetch details from the database.

## Alternatives considered

- **Valkey everywhere:** an extra container and memory on home machines for no benefit at single-user scale.

## Consequences

- **Positive:** one fewer service at home; cloud scaling without code changes.
- **Negative:** `NOTIFY` payloads are limited to 8 KB, which forces the ID-only event style.
- **Follow-up:** a typed event catalog in `packages/events`.
