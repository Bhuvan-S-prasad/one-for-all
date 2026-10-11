# ADR-0003: Monorepo with pnpm and Turborepo

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Platform
- **Related:** ADR-0002, ARCHITECTURE.md §17

## Context

The API, worker, web app and mobile app share types, schemas and a client. Separate repositories would let the API contract drift from its clients. Server-only code (database, vault, harness) must never end up in a browser or mobile bundle.

## Decision

Use a pnpm workspace with Turborepo:

- `apps/` for deployables, `packages/` for libraries, `tooling/` for shared config, plus `infra/`, `evals/`, `docs/`.
- Enforce dependency rules R1 to R7 (ARCHITECTURE.md §17) with lint rules: packages never import apps; `core` imports nothing internal; web and mobile import only `core`, `contracts` and `client`; one public `index.ts` per package.
- The root holds workspace configuration only.

## Alternatives considered

- **Multiple repositories:** contract drift and coordinated releases for every API change.
- **A single package with folders:** no enforceable boundary between server and client code.

## Consequences

- **Positive:** one change updates the contract, server and both clients together; cached builds and tests per package.
- **Negative:** boundary lint rules must be maintained; the Expo Metro bundler needs workspace-aware configuration.
- **Follow-up:** `tooling/eslint` boundary rules and `tooling/tsconfig` presets in M1.
