# ADR-0044: The team roster is built from grants, and coordinators delegate first

- **Status:** Accepted
- **Date:** 2026-10-18
- **Area:** Runtime
- **Related:** ADR-0032 (delegation), ADR-0033 (group threads), ADR-0013 (policy in code), ARCHITECTURE.md §6.3, §7

## Context

A chief of staff given "choose a laptop, research it, draft me an email" did all the research itself, with 13 web searches and 5 page reads, and handed only the email to the Gmail agent. It never asked the Researcher or the operator, ran out of its 120k token budget and stopped (live run, 2026-10-18). Three things in the design invited this:

- **The roster says nothing about abilities.** `delegate_task` lists each agent as `slug: name, job` inside its own tool description. The Researcher's whole entry was "Research"; nothing said the operator can make spreadsheets and send files.
- **The coordinator holds the specialists' tools.** It was granted `web.search` and `web.read_url`. Doing the work itself is one call; delegating needs a written brief. A small model takes the short path.
- **Nothing makes it a coordinator.** Its standing rules said "Prefer handing work to the specialist over doing it yourself", and the free model ignored them. Writing such a rule for every new agent or tool doesn't scale, and §2 says prompts describe rules but never enforce them.

The roster is already live: `TeamDirectory.members` reads the active agents on every run, so a new agent is listed at once. What is missing is what each one can do, and a role that changes behaviour in code.

## Decision

**Each agent the team lists comes with a capability card built from its grants, and an agent marked as coordinator plans, delegates first and loses the tools a teammate covers.**

- **Capability cards.** `ToolExecutor.capabilities(ctx, agentId)` returns what an agent may use, grouped by app in plain words, from the same grants and connected apps that decide its tool list: `web: search, read pages`, `gmail: search, read, create draft (asks first)`. Platform tools (plan, memory, skills, reminders, delegation, artifacts) are left out: every agent has them. The team directory adds the card to each `TeamMember`, so a new agent, tool or connected app updates every roster with no prompt edits.
- **One roster for both tools.** `delegate_task` and `message_agent` list members as `- slug (Name): job` with a `can:` line. Full cards fit about 1,000 tokens at the 32k window; past that, the rest are one line each (TC.06 ranks them by the request once the roster moves into the system prompt).
- **A coordinator role.** `spec.role` is `specialist` (the default) or `coordinator`. A group's leader acts as one in that group. Coordinators get:
  - **a team block in the system prompt** (`harness.team`, versioned) instead of a list hidden in a tool description, with the coordination rules: plan first and give each item an owner, start independent handoffs in the same step, do outbound work last with the final results, check what comes back before answering;
  - **delegate first, in code:** a coordinator's tool list hides each of its own tools that an active teammate it can hand work to also has. With a Researcher on the team, the coordinator no longer sees `web.search`. A capability no teammate has stays with the coordinator, so a small team still works;
  - **owners in the plan:** `todo.write` items may name an owner (`[researcher] compare prices`).
- **Policy is unchanged.** Hiding is a listing rule, like proactive checks' read-only list (M5.10). A hidden tool called anyway is refused as not available, and every handoff still goes through grant, policy and taint as before (ADR-0032).

## Alternatives considered

- **A stronger standing rule per coordinator:** the free model ignored the one it had, and each new agent would need another edit.
- **A routing model call that picks the specialist:** one more model call per request against the free quota, and routing would be invisible; ADR-0033 already chose a coordinator agent that routes in the open.
- **Abilities written by hand on each agent ("hand me…"):** goes stale as grants change. Generated cards are always true; a short optional hint can come later.
- **Remove all doing tools from coordinators:** a team without a researcher would leave the chief unable to look anything up. Hiding only what a teammate covers keeps it useful at any team size.

## Consequences

- **Positive:** adding an agent or connecting an app changes routing with no prompt work; a weak model can't take the short path a teammate covers; the roster tells the model what each agent can really do.
- **Negative:** a coordinator does even small lookups through a teammate, a handoff and a child run each time. Cards cost about 40 tokens per agent. Hiding depends on the roster, so pausing the Researcher gives `web.search` back to the coordinator mid-chat, which is intended.
- **Follow-up:** TC.05 (cards in the team directory), TC.06 (role, team block, hiding, plan owners), TC.07 (the editor shows what a coordinator sees), TC.08 (routing evals).
