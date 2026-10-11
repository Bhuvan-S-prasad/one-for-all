# ADR-0034: A person's message steers the run in its chat, "stop" halts it, and routines yield

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Runtime
- **Related:** ADR-0006 (Inngest), ADR-0014 (runs), ADR-0015 (idempotency), ARCHITECTURE.md §6.3

## Context

§6.3 says a direct message from a person outranks background work: Inngest `cancelOn` stops the turn, or the message is injected at the next step boundary, and "stop now" halts immediately. Until M5.05 a message to a busy agent queued a second run behind the first (one run at a time per agent), so a correction ("only 0.9, please") was answered only after the agent had finished the wrong thing, and a routine kept a person waiting.

Inngest's concurrency limit counts only executing steps, so a queued run can start while the working run waits for an approval. Whatever takes a message from one run to another must be safe against that race.

## Decision

**A person's message in a chat where the agent is already working joins that run at its next step boundary; "stop" alone halts the work in the chat; a routine running elsewhere is set aside.**

- **Steering.** The API stores the message and a queued run as before. Before each model step, the working run claims the person's later messages in its thread whose runs for the same agent haven't started (`RunStore.claimFollowUps`). It locks those runs (`FOR UPDATE SKIP LOCKED`) and ends them as cancelled, with error code `steered` and stop reason `steered`. The messages join the run as user turns, framed by the versioned template `harness.steering`. They are logged as `run.steered` and restated in the task block. A run that is starting checks its status again after marking itself running, so a message is answered by one run only. A follow-up that arrives after the run's last step is answered by its own queued run, as before.
- **"Stop now".** A message that is only `stop`, `stop now`, `cancel`, `halt` or `abort` (any case, trailing punctuation) stops every unfinished run in that chat, through the same cancel event as the Stop button (`reason: stopped`), and starts no run. With nothing running, it is an ordinary message. Finished actions stay done.
- **Preemption.** When a person writes to an agent, the agent's routine runs in other chats are cancelled at their next step boundary (`reason: preempted`, stop reason `preempted`). The routine's chat gets a short note saying so. The routine runs again at its next time. Scheduled tasks and test runs are not preempted: a task is a one-off promise, and a test run was started by the person.
- **Priority.** Among queued runs of one agent, a person's message starts first (`priority.run` on `agent-run`).

## Alternatives considered

- **Cancel the working run and start over with every message:** loses the work done so far and spends the quota again. Steering keeps it.
- **No run for a follow-up, only injection:** if the working run has already taken its last step, the message would never be answered. Keeping the queued run as the fallback means nothing is lost.
- **A separate "steer" endpoint:** the person would have to know whether the agent is busy. The same composer works either way.
- **Preempt every kind of background run:** a scheduled task would be lost for good, and a delegated child would fail its parent.

## Consequences

- **Positive:** corrections land while the agent works. "Stop" works by typing, from any client or channel. A person never waits behind a routine.
- **Negative:** each step does one more small query. A routine run can be cut short by a chat message, and its work so far is not redone until its next time. A steered run is listed in Activity as cancelled, with the reason.
- **Follow-up:** show steering and the "set aside" note in the web timeline and the group chat screen (M5.11).
