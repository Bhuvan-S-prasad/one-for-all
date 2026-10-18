What happens, layer by layer, when you write: _"Find a work laptop under $1,200 and leave a recommendation in my Gmail drafts."_

```flow
You send the message | the web app posts it to the API over HTTPS
The API stores it and returns | it resolves your tenant context, saves the message and a queued run, and sends agent/message.received
Inngest starts agent-run | one durable function per run, with a concurrency key per agent
The harness assembles the prompt | typed blocks with token budgets: rules, identity, tools, task, memory, the chat record, history
The model gateway calls the model | it picks the tier, waits for a slot in the shared queue, and calls OpenRouter inside a durable step
The agent calls web.search | policy returns auto: read-only and granted
It reads pages | outside content is wrapped and labelled, and the run becomes tainted
!It calls gmail.create_draft | the run is tainted and the tool is outbound, so policy returns approve
The run pauses | step.waitForEvent("approval/decided") holds no process, for up to a day
You approve, maybe after editing | the call runs once, under its idempotency key
The agent replies | an episode is written and the run ends; a separate function learns facts afterwards
```

## What each step leaves behind

Every step above is also a `run_event`: an append-only, ordered log per run. The **Activity** page, the step trail under each reply, the evals and crash recovery all read the same log. Every model call records its prompt version, tokens and model; every tool call its policy verdict, approval and result.

## If the process dies halfway

Each model call and each tool call is its own durable step. If the app restarts in the middle, Inngest replays the function: finished steps return their saved results without running again, and the run continues from the first unfinished step. Code outside steps runs again on replay, which is why every side effect lives inside one.

## If you write again while it works

Your follow-up joins the running run at its next step. "Stop" alone cancels every run in the chat. See [Chats](/docs/chats).

## If it runs out of budget

At 80% of its token or step budget the agent is told to finish. If it still runs out, one last call without tools writes the answer from what it has, the reply says what is left, and its [chat record](/docs/teams) lets "continue" carry on.
