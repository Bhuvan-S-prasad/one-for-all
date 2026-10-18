Everything lives in one Postgres 17 database with pgvector, through Drizzle. Every table carries `workspace_id` and is protected by row-level security. Run tables are append-only.

## Tables by group

| Group         | Tables                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy       | `workspace` (with its time zone), `user`, `membership`                                                                                                                                        |
| Agents        | `agent` (the spec), `agent_grant`, `skill`, `routine` (cron, time zone, its own chat, next time)                                                                                              |
| Connections   | `connection` (one person's sign-in; encrypted tokens), `mcp_server` (catalog entries and custom servers; pinned address and sign-in site, encrypted OAuth client), `secret` (named, redacted) |
| Conversations | `thread` (direct, group with a leader, or handoff), `thread_member` (people and agents; a person's read point), `message`, `thread_state` (each agent's working record in a chat)             |
| Execution     | `run` (trigger, parent run, routine, proactive), `run_event`, `tool_call` (idempotency), `approval`, `artifact`                                                                               |
| Memory        | `memory` (typed, scoped, verified or not), `episode`, `schedule` (a task or reminder for later)                                                                                               |
| Governance    | `policy_rule` (ask first or allow, per tool pattern, workspace-wide or one person's), `audit_log`                                                                                             |

## Row-level security

Every query runs in a transaction that sets the workspace (`app.workspace_id`), and the row-level security policy on every tenant table checks it. A test lists every tenant table and fails if one lacks row-level security, so a new table can't be forgotten.

The sign-in tables (`user`, `session`, `account`, `verification`) sit outside it: one person can belong to several workspaces, and sign-in happens before a workspace is known. A person reaches workspace data only through `membership`, which is under row-level security.

## Work that spans workspaces

A few background jobs must find work across workspaces: due routines, due nightly tidy-ups, sign-ins to refresh, and vault key rotation. They read only IDs through the owner connection, then do each piece of work as its owner through tenant-scoped queries.

## Migrations

Schema changes are Drizzle migrations; row-level security for each new tenant table is added by hand in the same migration. In the self-host bundle, migrations run when the app starts.

```sh
pnpm --filter @ofa/db db:generate   # a migration from schema changes
pnpm --filter @ofa/db db:migrate    # apply it
```
