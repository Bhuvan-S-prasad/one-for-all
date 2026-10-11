# ADR-0006: Durable execution with self-hosted Inngest

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Runtime
- **Related:** ADR-0014, ADR-0015, ARCHITECTURE.md §6, §11

## Context

Agent runs last minutes to hours, pause for human approval, and must survive restarts. Routines run on schedules. All model calls must share OpenRouter's rate limit. Users must be able to interrupt a running agent. Inngest's cloud Hobby plan caps monthly executions and every step counts, so a single agent task can use dozens. Inngest supports self-hosting as a single service backed by Postgres (1.0, January 2026).

## Decision

Every agent run, routine, delegation and background job is an Inngest function in `packages/orchestrator`, served by `apps/api` (self-host all-in-one) or `apps/worker` (cloud). Each model call and tool call is a `step.run`. Use:

- `step.waitForEvent` for approvals,
- `step.invoke` for delegation to another agent,
- cron triggers and `step.sleepUntil` for routines and reminders,
- concurrency and throttle keys for per-agent limits and the shared model quota,
- `cancelOn` for user interrupts.

## Alternatives considered

- **BullMQ:** a good queue, but no durable steps or event waits; approvals would have to hold state manually.
- **Inngest Cloud:** execution caps on the free plan.
- **Trigger.dev:** strong for long-running tasks and fully open source, but the approval-wait pattern is Inngest's strength.

## Consequences

- **Positive:** runs resume after a crash; approval waits hold no process or memory; scheduling, concurrency and cancellation come built in.
- **Negative:** one more container; code outside `step.run` re-executes on replay, so every side effect must live inside a step.
- **Follow-up:** harness helpers that make stepping the default; a review checklist for side effects outside steps.
