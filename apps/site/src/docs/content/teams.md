Agents work as a team: one hands a piece of work to another, several run at once, and a coordinator plans the whole thing.

## Handing work over

An agent hands work on with `delegate_task`: it names a teammate and writes a **brief**. The teammate starts a fresh run in a thread of its own, from the brief alone (never the whole conversation), and its answer comes back to the agent that asked, as `{agent, status, answer}`.

- **Several at once.** Handoffs made in the same step start together; the agent continues when all have answered.
- **One level deep.** A teammate working from a brief can't hand work on again, so agents can't pass work around in circles.
- **Taint travels both ways.** A handoff from a tainted run starts tainted, and an answer from a teammate that read outside content taints the agent that asked.
- **Results passed by name.** A brief can carry earlier answers in full: `include_results_from: ["researcher"]` adds every answer the Researcher gave in this task, and in this chat after a "continue".
- **Missing input is said, not guessed.** A teammate whose brief lacks something it needs says so and stops, instead of searching for it or redoing the work.
- **You see it all.** Each handoff appears under the reply as a card, with the teammate's steps, its answer and its files.

## The coordinator role

Give an agent the role **Leads a team** and it becomes a coordinator, like a chief of staff. A group chat's leader acts as one in that group. A coordinator gets three things, all enforced by the harness rather than asked for in a prompt:

1. **The team in its system prompt**, ranked by how well each agent matches the request, with rules: plan first with an owner on every item, start independent handoffs together, leave anything that goes out until last, check what comes back.
2. **No tools a teammate covers.** With a Researcher on the team, the coordinator no longer has `web.search`. A tool no teammate has stays with it, so a small team still works. A hidden tool called anyway is refused.
3. **No messages that wait.** Outside a group it leads, it hands work out with `delegate_task` and gets the answer in the same turn.

## Capability cards

Every list of teammates shows what each one can do, worked out from its grants and connected apps:

```text
- researcher (Researcher): Research
  can: web: search, read pages
- inbox (Gmail agent): Reads my email and writes drafts for me to approve
  can: Gmail: search messages, read message, create draft (asks first)
```

Hatch a new agent or connect an app, and every roster updates on its own: no prompt to edit. The coordinator's editor shows a preview, **What your coordinator sees**, with the same cards.

## "Continue" continues

Every agent keeps a **chat record** per chat: its latest plan, a ledger of what it did (actions, handoffs with their answers, searches, pages read), its notes, and how its last run ended. The record is written by the harness from tool results, never by the model, and saved after every step that changed it, so a run that fails or is stopped keeps its progress.

```flow
A run stops at its budget | it makes one last call without tools to answer with what it found
The reply says where it got to | what was done, what is left, and "Reply continue"
You say "continue" | a new run starts in the same chat
!It reads the record | "Earlier in this chat you already did this work", with the open plan as its plan
It carries on | finished items are not redone; the same search never runs twice in a task
```

## Messages between agents

`message_agent` posts a message in the chat and wakes another agent, which replies there later. It is for passing something on without waiting. Like handoffs, it goes one hop: an agent woken by another can't wake a third.
