# ADR-0020: Identity tables sit outside tenant row-level security

- **Status:** Accepted
- **Date:** 2026-10-01
- **Area:** Security
- **Related:** ADR-0001, ADR-0017, ARCHITECTURE.md §15

## Context

ADR-0001 says every table carries `workspace_id` and is protected by row-level security. Authentication does not fit that rule:

- A person can belong to several workspaces (a hosted version, or a shared self-hosted install later). Their login identity cannot belong to one of them.
- At sign-in there is no workspace yet. The session must be looked up from a cookie before any `TenantContext` exists.
- Better Auth owns four tables (`user`, `session`, `account`, `verification`) and queries them through its Drizzle adapter. It cannot set our per-transaction RLS variables.

## Decision

The four identity tables are global: no `workspace_id` and no row-level security. A user reaches workspace data only through a `membership` row, and every workspace-scoped table stays under RLS.

The boundary is narrow:

- Only Better Auth and two repository functions (`bootstrapOwner` and `findInstallOwner`) touch identity tables directly.
- Session resolution reads memberships with `withUser()`. RLS then shows only the caller's own memberships (`membership.self_read`) and the workspaces they belong to (`workspace.member_read`).
- An integration test lists every table with a `workspace_id` column and fails unless it is in `TENANT_TABLES` with RLS forced, so a new tenant table cannot skip its policy.

## Alternatives considered

- **`workspace_id` on `user`:** ties a person to one workspace, so multi-workspace users need duplicate accounts and passwords.
- **RLS on identity tables keyed on the user ID:** Better Auth's adapter cannot set the session variable before it knows the user, and sign-in is the step that finds out.
- **A separate identity service or database:** more moving parts for a self-hosted bundle with a ~3 GB RAM budget.

## Consequences

- **Positive:** standard Better Auth with no patches; multi-workspace users work without changes to the schema.
- **Negative:** a bug in code that queries identity tables could read other users' identity rows. These tables hold no workspace data; password hashes sit in `account`. We contain this by keeping such queries in `packages/db` and reviewing any new one.
- **Follow-up:** when invites and multiple workspaces arrive, add tests that a user cannot see members of workspaces they do not belong to.
