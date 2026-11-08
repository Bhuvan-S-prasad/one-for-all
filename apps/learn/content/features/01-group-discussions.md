---
title: Group discussions
summary: Ask a whole group a question; members answer one at a time, each reading the others, and the coordinator closes with one agreed answer.
---

## What it does

In a group chat, a message usually gets **one** responder. But sometimes you want the whole team's view: "should we build our own ticket tracker or buy one?". Writing `@all` (or `/discuss`) starts a **discussion**:

- the members answer **one at a time, in a fixed order**, each reading the answers before theirs;
- there are at most **three rounds** (two by default); from round two a member with nothing new **passes**, and a round where everyone passes ends the rounds early;
- the group's **coordinator closes** with one agreed answer that credits each member, and the chat pins it;
- **"stop"** ends it at once.

The coordinator can also start one itself with the `ask_group` tool. The decision record is [ADR-0050](adr:0050).

## Architecture

Each layer adds one piece. Notice that no agent ever starts another agent's turn: only the orchestrator does.

```layers
Web app | The turn bar, folded turns, the pinned answer | apps/web/src/components/chat/discussion.tsx
API | Recognises @all or /discuss, opens the discussion, stops it, lists it | apps/api/src/lib/turns.ts, apps/api/src/services/discussions.ts
Orchestrator | The discussion-run job: one durable function per discussion | packages/orchestrator/src/functions.ts
Harness | runDiscussion runs the turns in order; each turn is a normal agent run with turn instructions | packages/harness/src/discussion.ts, loop.ts
Tools | ask_group, for the coordinator; turns lose message_agent, delegate_task and ask_group | packages/tools/src/builtins/team.ts
Database | discussion and discussion_turn, with row-level security | packages/db/src/schema/discussions.ts
```

## The flow

```sequence
Person -> API: POST message "@all which tracker?"
API -> Postgres: save the message; open a discussion
API -> Inngest: group/discussion.started
Inngest -> Orchestrator: discussion-run calls runDiscussion
Orchestrator -> Agent run: turn 1 (Priya)
Agent run --> Postgres: Priya's answer
Orchestrator -> Agent run: turn 2 (Marco reads Priya)
Agent run --> Postgres: Marco's answer
note: … every member, each round, one at a time …
Orchestrator -> Agent run: the close (the coordinator)
Agent run --> Postgres: the agreed answer
Postgres --> Person: live updates over the WebSocket
```

## Starting one

When you send a message in a group, [startAgentTurn](code:apps/api/src/lib/turns.ts#startAgentTurn) first asks whether it joins or starts a discussion:

```code
apps/api/src/lib/turns.ts#joinOrStartDiscussion
```

Two rules in there are worth noticing. While a discussion is open, your message **starts no run**: it is saved, and the next member reads it in the conversation, so "focus on cost" steers the rest. And who takes part comes from a small pure function, easy to test:

```code
apps/api/src/lib/routing.ts#discussionFor
```

`discussions.open` (in [createDiscussionService](code:apps/api/src/services/discussions.ts#createDiscussionService)) writes the row and sends `group/discussion.started` to Inngest. The discussion's ID is derived from the request, so a retried request opens one discussion, not two.

## The turns

The job `discussion-run` (see [Jobs and events](/jobs)) wraps one function from the harness:

```code
packages/harness/src/discussion.ts#runDiscussion
from: for (let round = 1; round <= plan.rounds; round += 1) {
to: return end("done", closed.messageId);
```

Each turn is two steps: one makes the turn's run in the database (`startTurn`, which returns nothing if the discussion was stopped), and one **invokes** a normal `agent-run` and waits for it to finish. This is the same `invokeRun` a handoff between agents uses, which is why the turns can never overlap, and why a crash in the middle resumes at the right turn instead of starting over.

### What a member reads

A turn is an ordinary agent run with two differences. It gets turn instructions as its last message, telling it who takes part, the round, its place in the order, and to build on what was said:

```code
packages/harness/src/prompts.ts#DISCUSSION_TURN
```

And it gets no way to bring in another agent: the loop removes `message_agent`, `delegate_task` and `ask_group` from its tools, and caps it at 8 steps. A member whose whole answer is `NOTHING_TO_ADD` **passes**: the loop posts nothing and reports `passed` back.

## The data

```table
discussion
```

```table
discussion_turn
```

A partial unique index allows only **one open discussion per thread** (`status in ('active', 'closing')`). Each turn's run gets the trigger `discussion` in the [run](table:run) table, and the discussion's `tainted` flag carries forward: once a turn has read a web page, every later turn starts tainted ([ADR-0013](adr:0013)).

## The API

```endpoints
/api/threads/:id/discussions
```

Starting and stopping go through the normal [send endpoint](api:POST:/api/threads/:id/messages): `@all` or `/discuss` starts one, and "stop" ends it. Stopping any turn's run from its own Stop button ([POST /api/runs/:id/stop](api:POST:/api/runs/:id/stop)) ends the whole discussion too. Live changes reach the screen as `discussion.updated` over the WebSocket.

## On screen

The bar above the composer says whose turn it is, from a small function over the discussion's turns:

```code
apps/web/src/lib/discussions.ts#progressOf
```

Once it closes, the turns fold into one line ("The discussion: 4 messages with 3 agents") and the agreed answer is pinned under the header.

## How it's tested

- Unit tests run `runDiscussion` with scripted models: order, passes ending rounds early, stop between turns, taint carried forward, no second run on a replay.
- An API integration test runs a whole discussion against a real Postgres.
- Two evals run it on live models: one checks that the close credits every member's point, one that members told never to pass still stop after three rounds.

```code
evals/suites/discussion.ts#discussionSuite
from: checks: [
to: ],
```
