# ADR-0004: Postgres with pgvector, bundled

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Platform
- **Related:** ADR-0001, ADR-0005, ADR-0006, ADR-0007, ARCHITECTURE.md §14, §15

## Context

Agents run around the clock, so the worker and Inngest query the database constantly. We need relational data, vector search for memory, row-level security, and a free setup. Neon's free plan (2026) gives 100 CU-hours per project per month and 0.5 GB of storage. Its smallest compute is 0.25 CU, so a database that never scales to zero stays within the free allowance for about 400 of the month's ~730 hours, roughly 16 days.

## Decision

Run Postgres 17 with the pgvector extension inside the self-hosted Compose bundle. It holds app data, embeddings, Inngest state and (through `LISTEN/NOTIFY`) the self-host event bus.

## Alternatives considered

- **Neon:** runs out of free compute in about 16 days under an always-on worker; 0.5 GB fills quickly with messages, memory and embeddings.
- **SQLite or PGlite:** the API and worker processes both need access, and there is no row-level security.

## Consequences

- **Positive:** no quotas; near-zero latency; one database for everything; the same engine in cloud mode (managed Postgres).
- **Negative:** users own their backups and upgrades; roughly 300 MB to 1 GB of RAM.
- **Follow-up:** `infra/scripts/backup.sh` (nightly `pg_dump`) and `restore.sh`; a backups guide.
