# ADR-0032: Delegation goes one level deep, from a brief, with taint carried both ways

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Runtime
- **Related:** ADR-0006 (Inngest, `step.invoke`), ADR-0013 (taint escalation), ADR-0014 (the run), ADR-0015 (exactly once), ADR-0027 (address provenance), ARCHITECTURE.md §6.3

## Context

§6.3 says `delegate_task(agent, brief)` starts a child run with `step.invoke`, the child starts from a brief rather than the parent's transcript, and independent delegations run at the same time. It leaves open how deep delegation may go, where the child's conversation lives, and how a child relates to its parent's taint. Each of these has a failure mode:

- **Depth:** agent A waits on B, B hands to A, and so on, burning the free model quota in a loop nobody asked for.
- **Where it lives:** writing the brief into the person's own chat with the specialist makes the handoff that chat's latest thread, so the person's next message lands in it.
- **Taint:** a brief is written by a model that may have read an injected email. A child that started clean could carry out what the email asked with no approval, and a child's answer may itself carry outside words back to the parent.

## Decision

**A run hands work to another agent as a child run, one level deep, in a thread of its own, and taint flows from parent to child and from child back to parent.**

- **The harness runs the handoff.** `delegate_task` goes through the executor like any tool, so the grant and policy apply and the target is checked. The harness then makes the child in its own step and waits on it with `StepRunner.invokeRun` (`step.invoke` on `agent-run`). All handoffs from one model step start before any is awaited, so they run at the same time (fork-join).
- **One level.** A run that is itself a handoff gets no team members, so `delegate_task` isn't listed and a handoff is refused. A run can't hand work to its own agent, or to a paused or archived one.
- **A handoff thread.** A new thread kind, `handoff`, holds the brief (written by the delegating agent) and the child's reply. It never appears among the person's chats. The child reads the brief as its request, framed by the versioned template `harness.handoff`.
- **Taint both ways.** A child of a tainted run starts tainted. In such a child, addresses in the brief don't count as given (ADR-0027). A child that read outside content returns its answer as outside content, which taints the parent.
- **No learning from briefs.** A delegated run doesn't extract memories: its request was written by a model, not the person.
- **Exactly once.** The child run and its thread take IDs derived from the delegating call's idempotency key, so a retried step finds the child it already made.
- **Stop stops children.** Stopping a run sends a stop for each child that hasn't ended.
- **The result is structured.** The delegating model reads `{"agent", "status": done | stopped | failed | cancelled, "answer"?, "note"?}`; the answer is the child's reply, up to 8,000 characters. The wait lasts up to 25 hours, since a child may itself wait a day for an approval.

## Alternatives considered

- **Any depth with a loop check:** a check catches only exact repeats, and every level multiplies model calls against a 1,000-a-day quota. Deeper teams can come later with an explicit budget per chain.
- **The child's run without a thread, the brief in the event:** the brief and reply would be invisible in Activity, and the harness would need a second way to read a request.
- **The brief in the person's direct chat with the specialist:** hijacks that chat (see Context).
- **Delegated runs start clean:** lets an injected instruction escape approval by being handed to another agent.
- **Run the handoff inside the tool:** `step.invoke` can't be called inside `step.run`, and parallel handoffs need the loop to wait on all of them together.

## Consequences

- **Positive:** a coordinator can split work across specialists and get both answers in the time of the slower one; each child is a normal run with its own log, grants and approvals; injected instructions can't launder themselves through a handoff.
- **Negative:** a specialist can't hand work on (a researcher can't ask a writer); a child of a tainted parent asks for approval more often.
- **Follow-up:** group threads and `@mention` routing (M5.04) reuse the team directory; a per-chain budget if deeper delegation is ever needed.

## Amendment (2026-10-18, TC.10)

The live check of the laptop task (TC.09) found that a brief-only child works only if the delegating model copies results into the brief by hand. A chief wrote "the findings are in the previous delegate_task response" three times; the operator, which can't see that response, searched its computer for it and then redid the research until its budget ran out. Three changes keep the decision (a child sees only its brief) and make it hold up:

- **Earlier answers travel by name.** `delegate_task` takes `include_results_from: ["researcher"]`; the harness adds those handoffs' answers from this run to the brief in full. The model names them instead of retyping them.
- **A child says what is missing.** The brief's framing (`harness.handoff@2`) tells it to reply at once with what it wasn't given rather than look for it or recreate it.
- **The person sees the handoffs.** Handoff threads still stay out of the chat list, but the reply that handed work on shows a card for each: who, the brief, how it ended, its steps, its answer, a link to its run in Activity (`GET /api/runs/:id/handoffs`). Files a child made appear under that reply, so a file the operator writes reaches the person through the chief.

