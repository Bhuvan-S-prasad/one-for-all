# ADR-0021: The API client is built from contracts, not Hono RPC types

- **Status:** Accepted
- **Date:** 2026-10-01
- **Area:** Clients
- **Related:** ADR-0002, ADR-0003, ARCHITECTURE.md §13, §17

## Context

ADR-0002 planned `packages/client` as a typed Hono RPC client. Hono RPC gets its types from the server app's type (`typeof app`). That means `packages/client` would have to import from `apps/api`, which breaks dependency rule R1 (packages never import apps). It would also pull server-only types into the web and mobile type graphs.

RPC types also check shapes only at compile time. A server and client from different builds can still disagree at runtime.

## Decision

`packages/client` is a small fetch wrapper built on the zod schemas in `packages/contracts`, which both the API and the client already import. Every response is parsed with its schema. Errors become an `ApiError` with the stable `code` from `packages/core`. TanStack Query options and hooks live alongside it.

## Alternatives considered

- **Hono RPC with an exported type-only package:** moves the problem rather than solving it. The package would still depend on the API's route definitions.
- **OpenAPI generation:** adds a generate step and a spec file to keep in sync, for the same schemas we already have.

## Consequences

- **Positive:** the import boundaries hold; runtime validation catches mismatches between server and client; web and mobile share one client.
- **Negative:** each endpoint is declared twice, once in the API route and once in the client. Both use the same contracts schema, so a mismatch fails typecheck or a test.
- **Follow-up:** add a test per endpoint that the client and the route agree, as endpoints grow in M2.
