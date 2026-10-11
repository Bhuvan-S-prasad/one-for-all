# ADR-0033: Group threads give each message one responder; agents message each other one hop

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Runtime
- **Related:** ADR-0013 (taint escalation), ADR-0027 (address provenance), ADR-0032 (delegation), ARCHITECTURE.md §6.3

## Context

§6.3 says two to six agents can share a thread, an `@mention` picks an owner and otherwise a coordinator routes the message; and that `message_agent` posts to another agent and wakes it, with the reply arriving later in the same thread. It leaves open who the coordinator is, what happens with several mentions, which agents a message may reach, what the woken agent sees, and how to stop agents messaging each other in a loop.

## Decision

**Every person's message in a group thread gets exactly one responder, and an agent's message to another agent wakes it once, in the same thread.**

- **The coordinator is stored on the thread** (`thread.coordinator_agent_id`, migration 0013): the agent named when the group is made, or its first agent. A group holds the person and two to six agents.
- **One responder per message:** the member `@mentioned` first (by handle or name, not inside an address or a longer word), otherwise the coordinator. That agent's run may answer, or pass the message on with `message_agent` (reply later, in the thread) or `delegate_task` (wait for the result). Several mentions don't start several runs; the responder can involve the others.
- **`message_agent` posts in the thread the run is in.** In a group, only its other members can be messaged; in a direct chat, any other active agent, whose reply then appears in that chat under its own name. The message is written by the sending agent, and the run that answers it (`trigger: event`) remembers the sending run as its parent.
- **One hop.** A run started by another agent (a message or a handoff) can neither message nor delegate, so agents can't wake each other in a loop.
- **The woken agent sees the thread** (it is in the conversation) with every agent's messages labelled by name, and the message that woke it as its request (versioned template `harness.agent_message`).
- **Taint and trust as for handoffs:** a message from a tainted run wakes a tainted run, whose copy of the message's addresses doesn't count as given; a woken run doesn't learn memories.
- **Exactly once:** the woken run takes an ID from the sending call's idempotency key, and its start event carries the run ID, so a retried step posts once and starts one run.
- **Grants:** `message_agent` needs a grant like any tool. A coordinator needs "Message other agents" (or "Hand work to other agents") to route.

## Alternatives considered

- **A model call (not an agent) routes each message:** one more model call per message, and the routing decision would be invisible; a coordinator agent routes in the open, with its own tools and voice.
- **Every mentioned agent answers:** runs that don't know about each other answer the same message at once; one responder can bring others in deliberately.
- **Woken agents may message on:** loops that burn the quota; chains can come later with a budget, as for delegation (ADR-0032).
- **The woken agent sees only the message:** in a group it is already a member and reads the conversation anyway; in a direct chat the sending agent chose to bring it in.

## Consequences

- **Positive:** a person can talk to a team in one place; routing and handoffs are visible messages; no new loop risk.
- **Negative:** a specialist that is `@mentioned` can't wake a third agent, only delegate to it if it is the first responder; a coordinator without a messaging grant just answers itself.
- **Follow-up:** the group chat screens (M5.11); interrupts while several agents work (M5.05).
