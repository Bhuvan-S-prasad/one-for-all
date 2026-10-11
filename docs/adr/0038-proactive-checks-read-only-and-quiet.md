# ADR-0038: Proactive checks are read-only routines that never wait and speak only when needed

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Security
- **Related:** ADR-0013 (taint escalation), ADR-0027 (address provenance), ADR-0035 (routines), ARCHITECTURE.md §10.3

## Context

§10.3 says proactive background work uses read-only tools only. M5.10 asks for proactive background checks: an agent looks at something on a schedule (a release page, an inbox, a status page) and tells the person only when something needs them. A routine (ADR-0035) already runs on a schedule, but it replies every time and may use every tool the agent has. Nobody is watching a background check, so there's no one to approve anything and no reason to post "nothing new" every hour.

## Decision

**A check is a routine of kind `check`. Its run is marked proactive, and policy refuses anything that isn't read-only, or that would need a person. It replies only when something needs attention.**

- **`routine.kind`** (migration 0016) is either `task` (the default) or `check`.
  - A check's run gets `run.proactive = true` and carries its request on the run (`run.request`) instead of posting a note in the chat.
  - A quiet check leaves the chat untouched.
- **Policy, not the prompt** (hard rule 5). `PolicyInput.readOnly` makes the engine deny:
  - **anything not annotated read-only**, whatever the grant says;
  - **anything that would end in `approve` or `human`.** In the live check, a check's own search tainted it, so opening an address it had built would have waited a day for a person (ADR-0027). It is refused instead, and the agent is told to mention it in its reply.
- **What the model sees:** `listTools(…, { readOnly: true })` shows the model only read-only tools, so it doesn't try the others. A plan (`todo.write`) is now annotated read-only; it changes nothing outside the run.
- **Quiet by default** (`harness.check@2`):
  - The request ends with how to answer: the single word `NOTHING_TO_REPORT` when nothing needs the person, otherwise a brief note of what and why.
  - A reply that is that word, or that opens or closes with it, posts nothing. The run log records `check.quiet`.
  - A finding is posted in the routine's chat, where it shows as unread (M5.11).
- **Like other routines:** checks don't learn memories, they give way to a person's message (ADR-0034), and they pause when the owner is away.

## Alternatives considered

- **A read-only grant set per routine:** this duplicates what tool annotations already say, and drifts as tools change.
- **A prompt instruction to read only:** a permission must not live only in a prompt (hard rule 5); injected content can talk a model out of it.
- **Let a check wait for approvals:** the person isn't watching, so the run would sit for a day holding a routine slot.
- **Always post the result:** an hourly check would bury the chat in "nothing new" and make unread meaningless.
- **A second model call to classify "needs attention":** this doubles the quota for every check. One answer word, read leniently, was enough in the live check once the instruction came last.

## Consequences

- **Positive:** an agent can keep watch without being able to change or send anything, and it interrupts the person only when it matters.
- **Negative:**
  - A check can't open an address it built after reading outside content; it says so in its reply instead.
  - The quiet word depends on the model following an instruction: one free model explained instead until the instruction moved to the end.
- **Follow-up:** "All quiet · 14 checks today" on agent cards (the canvas shows it), from `check.quiet` events.
