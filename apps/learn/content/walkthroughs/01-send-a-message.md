---
title: Send a message
summary: Follow one chat message from the composer to the agent's reply on your screen, through every layer, with the real code at each stop.
---

You type "find me three laptops under $1,200" to your researcher and press Enter. A few seconds later a reply appears, written live. This page follows that message the whole way.

## The whole trip

```sequence
Browser -> API: POST /api/threads/:id/messages
API -> Postgres: save the message and a queued run
API -> Inngest: event agent/message.received
API --> Browser: 201: the message and the run
Inngest -> Harness: agent-run calls runAgent
Harness -> Model: prompt and tool list
Model --> Harness: text, or tool calls
Harness -> Tools: each call checked by policy, then run
Harness -> Postgres: the reply and the run log
Postgres --> API: NOTIFY message.created
API --> Browser: WebSocket: the new message
```

Two things to notice before the details:

- **The API answers right away.** It doesn't wait for the agent: it saves the request, hands the work to Inngest and returns `201`. The agent might take seconds or wait a day for your approval.
- **The reply comes back by a different road.** Not as the HTTP response, but as a live update over a WebSocket, the same way every change reaches the screen.

## 1. The composer, in the browser

The agent chat screen has a `Composer`. When you press Enter, it calls `onSend`, which the chat page wires to a mutation from `@ofa/client`:

```code
packages/client/src/hooks.tsx#useSendMessage
```

`useMutation` comes from TanStack Query: it runs the request, tracks loading and errors, and on success stores the returned message and run in the cache (`rememberTurn`), so the screen shows your message and a "working" state immediately. The request itself is built by the typed API client:

```code
packages/client/src/api-client.ts#createApiClient
from: sendMessage: (
to: ),
title: The API client: one method per endpoint, each checked against a zod schema
```

The third argument, `sendMessageResponseSchema`, is a zod schema from `@ofa/contracts`. The client checks the server's answer against it, and the server uses the same package to check the request, so both sides agree on the shape of every message.

## 2. The endpoint, in the API

The request arrives at the Hono app. Before any route runs, middleware checks the Origin header (against cross-site requests), reads the session cookie and sets the **tenant**: which user and workspace this request acts for. Then the threads router handles it:

```code
apps/api/src/routes/threads.ts#threadRoutes
from: .post("/:id/messages", async (c) => {
to: return c.json(sent, 201);
title: POST /api/threads/:id/messages
```

`readJson` parses the body with `sendMessageRequestSchema` (a bad body gets a `422` without reaching any other code). `getThread` loads the chat through a repository function that takes the tenant, so a thread from another workspace simply isn't found. Attached files become lines in the message. Then the real work starts in `startAgentTurn`.

```endpoints
/api/threads/:id/messages
```

## 3. Choosing who answers, and saving the turn

`startAgentTurn` handles a few special cases first: "stop" stops the work in the chat, and in a group a message to `@all` starts a [discussion](page:features/group-discussions). Otherwise it picks the agent that answers (in a direct chat, its agent; in a group, the one you `@mention` or the coordinator) and saves the turn:

```code
apps/api/src/lib/turns.ts#startAgentTurn
from: const agent = await responderFor(deps, tenant, thread, content);
to: trigger: "message",
```

`startTurn` writes the message and its run **in one transaction**: either both exist or neither does. The run starts `queued`.

```code
packages/db/src/repos/conversations.ts#startTurn
```

Two rows were written:

```table
message
```

```table
run
```

### Handing the work to Inngest

`deps.dispatcher.messageReceived` sends an event to Inngest. The event carries only IDs (the workspace, user, agent, thread, message and run); the job loads the rest itself.

```code
packages/orchestrator/src/client.ts#createRunDispatcher
from: async messageReceived(event) {
to: message-received-
```

The event ID is derived from the run ID, so if the request is retried, Inngest drops the second event and only one run ever starts. Finally the API returns `201` with the message and the queued run.

## 4. The job: `agent-run`

Inngest receives `agent/message.received` and starts the function listening for it. Its configuration says a lot about how the system behaves:

```code
packages/orchestrator/src/functions.ts#createFunctions
from: const agentRun = inngest.createFunction(
to: retries: 4,
title: The agent-run function's settings
```

- **Concurrency** keys: one run at a time per agent and per chat; a second message waits its turn (or joins the running one, see "steering" in [ADR-0034](adr:0034)).
- **Priority**: your message jumps ahead of background routines.
- **cancelOn**: pressing Stop sends `agent/run.cancelled`, which cancels the function at its next step.
- **retries**: a failed step is tried again.

The function body hands everything to the harness:

```code
packages/orchestrator/src/functions.ts#createFunctions
from: const result = await runAgent(
to: );
```

`inngestSteps` adapts Inngest's `step.run` to the harness's `StepRunner` port. That is the durability trick: every piece of work is a named step whose result Inngest saves. If the server crashes halfway, Inngest runs the function again from the top, and every step that already finished returns its saved result instead of running again. Nothing is sent twice.

## 5. The agent loop: `runAgent`

`runAgent` in [packages/harness](pkg:harness) is the heart of the system. In outline:

```flow
start | Load the run and the agent's spec; mark the run running; log run.started
context | Read the chat history, recall memories and earlier episodes, list the tools this agent may use
!loop | Build the prompt, call the model; if it asks for tools, run each one and loop again
reply | Save the final answer as a message in the chat
finish | Mark the run succeeded, log run.ended with usage, write an episode for memory
```

### Calling the model

Each turn of the loop assembles the prompt from budgeted blocks (rules, the agent's identity, memories, history, tool results; see [assembleContext](code:packages/harness/src/context.ts#assembleContext)) and calls the model inside a step named `model-<i>`:

```code
packages/harness/src/loop.ts#runAgent
from: const step: ModelStepResult = await steps.run(`model-${i}`, async () => {
to: usage = addUsage(usage, step.usage, { model: 1 });
```

`deps.llm` is the model gateway ([packages/llm](pkg:llm)): it picks a model for the agent's tier, queues calls to respect rate limits, and falls back to the next model on errors. If the model replies with plain text and no tool calls, that text is the answer and the loop ends.

### Running a tool

If the model asks for a tool, say `web.search`, each call goes to the **tool executor**, which validates the arguments against the tool's zod schema, asks the **policy engine** for a verdict, records the call with an idempotency key, and only then runs it. The policy engine looks at the agent's grant first:

```code
packages/policy/src/engine.ts#createPolicyEngine
from: async evaluate({
to: // 2. The always-human list
```

When the verdict is "ask a person", the harness creates an approval and **waits for an event** (`approval/decided`) without holding any process; you see a card in the chat, and the run continues when you answer. Results from outside (a web page) mark the run **tainted**, so anything it later sends out needs approval.

### Saving the reply

When the model answers, the reply is saved inside its own step, after removing any known secret values:

```code
packages/harness/src/loop.ts#runAgent
from: const posted =
to: : null;
```

## 6. Saving the reply, and announcing it

`deps.threads.addAgentMessage` is the `ThreadStore` port; its Postgres adapter inserts the message, and if it is new, **announces** it on the event bus:

```code
packages/db/src/runtime.ts#createThreadStore
from: async addAgentMessage(ctx, input) {
to: return asId<MessageId>(id);
```

The check for an existing reply by this run makes the step safe to repeat: a retried step finds the message it posted the first time. The announcement goes through Postgres `LISTEN/NOTIFY` ([createPgEventBus](code:packages/events/src/postgres.ts#createPgEventBus)), carrying only IDs.

## 7. Live on your screen

Every open browser tab keeps a WebSocket to `/api/ws`. The API subscribes to its workspace's bus topic, loads the row each announcement names (with the socket's own tenant, so row-level security still applies) and sends it down:

```code
apps/api/src/ws/gateway.ts#toRealtime
```

In the browser, `@ofa/client` receives it and updates TanStack Query's cache directly, so every component showing that chat re-renders with the new message, without fetching anything:

```code
packages/client/src/realtime.ts#applyRealtime
from: case "message.created": {
to: return;
```

The run's own updates (each step, the "working" loader, its end) travel the same way as `run.event` and `run.updated` messages.

## What calls what

The two functions this whole trip turns on, with everything they call and everything that calls them:

```calls
apps/api/src/lib/turns.ts#startAgentTurn
```

```calls
packages/harness/src/loop.ts#runAgent
```

## Where to go next

- [The big picture](page:path/big-picture), if you skipped it.
- [Group discussions](page:features/group-discussions): what changes when a message goes to `@all`.
- The [run_event](table:run_event) table, where every step above is logged, and [Jobs and events](/jobs) for the other background functions.
