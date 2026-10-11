# ADR-0005: Drizzle as the ORM

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Platform
- **Related:** ADR-0004, ARCHITECTURE.md §15

## Context

Agent memory needs vector columns and similarity queries. Tenancy relies on row-level security policies, which should live in versioned migrations beside the tables they protect. SQL-shaped queries with an escape hatch to raw SQL are preferred.

## Decision

Use Drizzle ORM for schema definitions, queries and migrations, including pgvector columns and RLS policies. Schema lives in `packages/db/schema/`, one file per aggregate.

## Alternatives considered

- **Prisma:** mature tooling, but vector columns are still `Unsupported` types, it needs a generate step, and RLS policies sit outside its schema.

## Consequences

- **Positive:** first-class vector support; RLS in migrations; no code generation; types come straight from the schema.
- **Negative:** fewer conveniences for relations, so some joins are written by hand.
- **Follow-up:** repository helpers that require a `TenantContext` and set the RLS session variable per transaction.
