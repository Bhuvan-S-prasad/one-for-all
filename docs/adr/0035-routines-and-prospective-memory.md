# ADR-0035: Routines fire from a minute tick; tasks and reminders sleep until due

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Runtime
- **Related:** ADR-0006 (Inngest), ADR-0013 (taint escalation), ADR-0034 (interrupts), ARCHITECTURE.md §8, §11

## Context

M5 needs agents that work on their own schedule. Routines are standing jobs ("every weekday at 7, brief me"). §8's prospective memory is something an agent sets for later: a reminder for the person, or a task for itself. §11 asks that routines pause after long inactivity and be skipped rather than queued when an agent is busy. Inngest cron triggers are fixed when a function is registered, so they can't carry one schedule per routine. Free model quotas are small, so a routine that runs every minute would use them up.

## Decision

**A routine is a row with a cron schedule. One Inngest cron function fires due routines every minute. A task or reminder is a row whose own Inngest run sleeps until it is due. In both cases the row is the truth.**

- **Routines** (`routine` table, migration 0014): agent, name, instructions, five-field cron, IANA time zone (default: the new `workspace.time_zone`), status, `next_run_at`. At most 50 per agent. A schedule may not run more often than every 15 minutes. Cron parsing is our own small module in `@ofa/core`, with no dependency, so the API checks exactly what the orchestrator runs.
- **Each routine has its own chat**, a direct thread with its owner, titled with its name. Each run posts its request there as a system note (`Routine "<name>": …`), read as the request through the versioned template `harness.routine`, and replies there. The routine's chat never becomes the person's current chat with the agent.
- **The `routine-tick` function** runs every minute. It lists due routines through the owner connection (they span workspaces, as the token refresh does), then fires each in its own step, as its owner, in one transaction:
  - It does nothing if `next_run_at` has already moved (a repeated tick).
  - It pauses the routine if its owner has written nothing and edited nothing for 14 days (`paused_reason: inactive`).
  - It skips the time if the agent is paused, if the time was missed by more than an hour (the server was off), or if the routine's last run is still going.
  - Otherwise it starts a run (`trigger: routine`, `run.routine_id`), with an ID derived from the due time.
  - Either way, `next_run_at` moves on.
- **API:**
  - Routines can be listed, created, renamed, rescheduled, paused, resumed (which also clears an inactivity pause) and deleted (its chat and runs stay).
  - A **test run** runs now (`trigger: manual`), one at a time.
  - Each routine lists its last 20 runs.
- **`schedule_task` and `remind_me`** are built-in tools behind grants ("Do tasks later", "Set reminders").
  - **Input:** a clock time in the workspace's time zone, or minutes from now. The tool's description tells the model the current time.
  - **Storage:** a `schedule` row (migration 0014) keyed by the tool call's idempotency key, at most 50 pending per agent, up to a year ahead. Each row starts the wait (`schedule/item.created`).
  - **The `schedule-fire` function** sleeps until the item is due (`step.sleepUntil`). A cancel ends the sleep (`cancelOn`), and the row is checked when the item fires.
  - **A due reminder** is posted in its chat as the agent's message, with no model call, even if the agent is paused.
  - **A due task** starts a run in the same chat (`trigger: schedule`), acting as the person it was set for. Its request is read through `harness.scheduled_task`. It starts tainted if the run that set it was. Work handed over by another agent can't set anything for later.
- **Routine and scheduled runs don't learn memories:** nobody is talking in them. Routines can delegate and message other agents like any run started by a person.

## Alternatives considered

- **One Inngest function or cron trigger per routine:** cron triggers are fixed at registration, so every routine edit would need the app re-registered.
- **A self-rescheduling `sleepUntil` loop per routine:** a lost event silently stops the routine. A tick over the rows heals itself.
- **The tick also fires tasks and reminders:** this works, but `sleepUntil` holds nothing for weeks, wakes on time without a database poll, and is what §8 describes. The row check keeps it safe.
- **A cron library from npm:** a new supply-chain dependency for a few hundred lines. We need only five standard fields and time zones through `Intl`.
- **Post routine results into the person's current chat:** that mixes standing jobs into conversations. A routine's own chat collects its history.

## Consequences

- **Positive:**
  - A morning routine runs by itself, and its history and output are in one place.
  - Reminders cost no model quota.
  - Restarts and repeated ticks start nothing twice.
- **Negative:**
  - Finding due routines needs `DATABASE_MIGRATION_URL` (the owner connection), as the token refresh does.
  - Missed times are skipped, not caught up.
  - During the autumn clock change, a time inside the repeated hour can fire twice.
- **Follow-up:**
  - The routines page and the list of pending items in the web app (M5.11).
  - A `create_routine` tool (§9.3).
  - Notifications when a routine finishes or a reminder is posted.
