# ADR-0050: A group discusses in turns, one agent at a time, and the coordinator closes

- **Status:** Accepted
- **Date:** 2026-10-20
- **Area:** Runtime
- **Related:** ADR-0033 (group threads, one responder, one hop; amended here), ADR-0032 (delegation), ADR-0034 (interrupts), ADR-0044 (coordinators), ADR-0013 (taint), ARCHITECTURE.md §6.3

## Context

In a group thread every message gets one responder (ADR-0033). That suits "do this", but not "what do you all think?": the coordinator either answers alone or messages members, whose runs then start at the same time, can't see each other's answers, and land in the chat in whatever order they finish. The person wants something closer to a meeting: each member says its piece knowing what was said before, and someone sums up.

The risks are the ones ADR-0033 avoided: agents waking each other in a loop, several runs answering at once, and a conversation that never ends and spends the quota. A discussion needs a fixed order, a hard limit, a clear end and a way to stop it.

## Decision

**A discussion is a set of turns run one at a time by the orchestrator, in a fixed order, for at most a fixed number of rounds; the coordinator closes it with one answer. No agent starts another agent's turn.**

### Starting one

- **The person**, in a group thread: a message that addresses the whole group (`@all`, `@everyone`, `@team`) or starts with `/discuss`. If the same message `@mentions` two or more members, those members take part, in the order they are named; otherwise every member but the coordinator takes part, in roster order (the order they joined the group). The message is the question; it starts no run of its own.
- **The coordinator**, in a run that answers a person's message in a group it leads: the tool `ask_group(question, order?, rounds?)`. It posts the question in the chat as the coordinator's message and the run ends its turn with a short reply; the discussion starts after it. Like `message_agent` it needs a grant of its own ("Ask the group"), and it isn't offered in a run started by another agent, in a discussion turn, or outside a group.
- **One at a time per thread.** A second discussion while one is open is refused, with the reason.
- The coordinator takes a turn only if it is named; it always closes.

### Turns

- **Order is fixed when the discussion starts** and kept: one turn per member per round, at most **3** rounds (2 by default; the coordinator may ask for 1 to 3). With at most six members that is at most 18 turns and a close.
- **Each turn is its own run** (`trigger: discussion`, linked to the discussion by a `discussion_turn` row), on the agent's own tools, with at most 8 steps. It reads the thread as any member does: the question, every earlier turn by name, and anything the person wrote since. Its instructions (versioned template `harness.discussion_turn`) say who is taking part, the round and its place in the order, to build on or disagree with what was said rather than repeat it, and to stay short.
- **Passing.** From round 2 a member with nothing new answers with a pass; a pass posts nothing. A round in which every member passes ends the rounds early.
- **No agent wakes another outside its turn.** A turn has no `message_agent`, `delegate_task` or `ask_group`, and while a discussion is open `message_agent` from any run in the thread is refused. Only the orchestrator starts turns.
- **One active run per thread.** Every run in a thread waits for the one before it to end (an Inngest concurrency key on the thread, beside the one per agent). A discussion's turns can then never overlap with each other or with other work in that chat.

### Closing

- After the last round (or a round where everyone passed), the coordinator runs a closing turn (`harness.discussion_close`): one agreed answer to the question, which says whose points it takes from and where members disagreed. That message is the discussion's answer (`discussion.closing_message_id`); the chat pins it.
- A discussion ends `done` (closed), `stopped` (by a person) or `failed` (the close failed after its retries; the chat says so, and the turns stay). A member's turn that fails is skipped, with the usual failure note from that member, and the discussion goes on.

### Interrupts

- **"stop"** (ADR-0034) in the thread ends an open discussion at once: it is marked `stopped`, the running turn is cancelled at its next step boundary, no further turn or close starts.
- **Any other message from the person** during a discussion starts no run. It is posted and the next turn reads it (so "focus on cost" steers the rest of the discussion). A member they `@mention` is not moved up the order.

### Trust and durability

- **Taint flows forward.** A discussion asked for by a tainted run starts tainted; a turn that reads outside content taints the discussion; every later turn and the close start tainted, and addresses in other agents' messages don't count as given in them (ADR-0027). Discussion runs don't learn memories.
- **Durable and exactly once.** The discussion is an Inngest function (`discussion-run`, on `discussion/started`). Each turn is one step that makes its run (its ID derived from the discussion, the round and the place in the order), then one `step.invoke` of the agent run that waits for it. A replay makes no second run and posts no second message. The stop sends `discussion/stopped`, which cancels the function (`cancelOn`), and the row is checked before each turn in case the two race.
- **The loop lives in the harness** (`runDiscussion`), on the same `StepRunner` as delegation, so evals run it without Inngest; the orchestrator only wraps it.

### Data

- `discussion` (migration 0021, RLS): its thread, the question message, the run that asked (if an agent did), the members in order, the rounds asked for, the current round, `status`, the closing message, `tainted`, times; at most one open per thread (a partial unique index). `discussion_turn` (RLS): one row per turn with its run, agent, round and place in the order (none for the close). `run_trigger` gains `discussion`.
- `GET /api/threads/:id/discussions` lists a thread's discussions with their turns (agent, round, run, status, message); a `discussion.updated` bus event keeps the chat live.

## What changes in ADR-0033

- "Every person's message gets exactly one responder" now has one exception: a message to the whole group starts a discussion, whose first turn is the first responder.
- The one-hop rule holds as written: a discussion turn is started by the orchestrator, not by another agent, and can't message or delegate.

## Alternatives considered

- **Members message each other freely until they agree:** no bound on turns or cost, and "agreed" is hard to detect; a fixed order and a round limit bound both.
- **Everyone answers at once (fan-out), then a summary:** cheaper in wall time, but each answer is made blind to the others, which is what the person was missing. Fork-join delegation already covers "ask several specialists separately".
- **A model call (not an agent) picks who speaks next:** an extra call per turn and an order nobody can predict; a fixed order is easy to read and to test.
- **The coordinator drives the turns itself with `delegate_task`:** the turns would be hidden in handoff threads instead of in the chat, and the coordinator's own budget would cap the discussion.

## Consequences

- **Positive:** the person can hear the whole team on one question, in order, in the chat, with one answer at the end; the cost has a known ceiling (members × rounds + 1 runs); stop works the same as everywhere.
- **Negative:** a discussion is slower than one agent answering (turns are sequential), and on free models each turn waits its turn in the shared queue. One active run per thread also means a message the coordinator sends to a member waits until the coordinator's run ends, where before both ran at once.
- **Follow-up:** the chat shows whose turn it is, folds the turns and pins the answer (EN.21); evals check the order, the limits and that the close reflects every member (EN.22).
