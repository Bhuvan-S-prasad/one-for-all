An always-on agent has to survive restarts, crashes, busy models and its own mistakes. Most of that comes from two choices: durable steps, and one append-only log per run.

## Durability

| Concern                | How it is handled                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| A crash mid-run        | Inngest durable steps: the run resumes at the last finished step                                |
| A send happening twice | Every tool call has an idempotency key (`runId:step`), recorded in flight before and done after |
| A model outage         | Fallback chains, circuit breakers, and waiting instead of failing                               |
| Long waits             | Approvals and timers use `waitForEvent` and `sleepUntil`, which hold no process or memory       |
| Runaway work           | Step and token budgets, loop detection, routines that pause themselves                          |
| Too much at once       | One run at a time per agent; routines skipped, not queued, when an agent is busy                |

**The rule:** code outside a durable step runs again on replay, so every side effect lives inside one.

## The durable functions

| Function              | Does                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `agent-run`           | One run of an agent, from trigger to reply                       |
| `agent-run-cancelled` | When a run is stopped, stops the work it handed to other agents  |
| `agent-learn`         | Learns facts after a run that replied                            |
| `routine-tick`        | Every minute: fires the routines that are due                    |
| `schedule-fire`       | Sleeps until a reminder or task is due, then fires it            |
| `memory-consolidate`  | The nightly tidy-up, at 3 at night in each workspace's time zone |
| `token-refresh`       | Every ten minutes: refreshes sign-ins about to run out           |

## The run log

Each run writes an append-only log of events. Every event carries a key chosen by its writer (`model-3`, `tool-3-0`), unique per run, so a retried step never writes twice; the database orders events under a lock on the run. Once a run has ended its log is closed. The same log feeds Activity, the step trail, traces, evals and audit. See the [run events](/docs/events).

## Observability

One OpenTelemetry trace per run, with a span per model call and tool call: latency, tokens, model, prompt version, policy verdict, taint and errors. Traces hold your data, so they stay on your machine.

## Evals

Agent behaviour is tested in `evals/`, against live models, through the real gateway, harness, tool executor and policy engine, in an in-memory world with recorded pages instead of the live web.

- **Golden cases** check that a task ends in the right state and took a sensible path.
- **Red-team cases** plant injection and exfiltration attempts that must end in an approval or a refusal.
- **Team cases** give an agent teammates: a coordinator routes research and drafts last; a ten-agent roster; a run that continues after its budget without searching again.
- **pass^k**: `--k` repeats each case, and a case passes only if every attempt does.

```sh
pnpm eval --list
pnpm eval --case continuity --k 3
```

The eval runner's own tests use a scripted model, so `pnpm test` needs no key and no quota.
