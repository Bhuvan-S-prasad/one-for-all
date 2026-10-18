The harness is everything around the model: what it reads, which tools it gets, what happens to each call, and when to stop. It shapes an agent's quality as much as the model does, so it is a package of its own (`packages/harness`) with its own tests and evals. It depends only on interfaces from `packages/core`: it never knows which database, sandbox or channel it runs on.

## The loop

```text
agent-run (Inngest function)
 ├─ start      load the agent's spec, grants and budgets; open the trace
 └─ loop until a stop condition
     ├─ assemble   build the prompt from budgeted blocks
     ├─ model      step.run("model-<i>") through the model gateway
     ├─ each tool call (in parallel when independent)
     │   ├─ check      schema, grant, policy verdict, taint, idempotency key
     │   ├─ approval   step.waitForEvent("approval/decided") when the verdict is approve
     │   ├─ execute    step.run("tool-<i>-<n>"); credentials added only here
     │   └─ after      log the event, redact secrets, store long output as an artifact,
     │                 mark taint for outside content
     ├─ record     save the chat record when this step changed it
 └─ end         write the episode, close the log, notify

agent-learn (a separate function, after a reply)
 └─ extract facts and the episode summary with a fast model
```

The checks around each call behave like middleware: policy, logging, redaction and memory work the same for every agent.

## Agents are specs

An agent is a declarative spec in the database: job, standing rules, voice, familiar, model tier, autonomy, role, memory scopes, budgets and grants. The harness reads it at the start of every run, so an edit applies to the next run.

## Stop conditions

| Stop                 | What the person sees                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Final answer         | The reply                                                                                                       |
| Needs a person       | An approval card; the run waits                                                                                 |
| Step or token budget | One last call without tools writes the answer from what it has; the reply says what is left and offers Continue |
| Loop detected        | The same tool with the same arguments again: the reply lists what was done                                      |
| You said stop        | The run stops at its next step boundary; finished work is not undone                                            |

From **80%** of the budget the task block tells the agent to finish the current item and answer.

## The chat record

After every model step that changed it, the harness saves the agent's working record for this chat in its own durable step: the plan, a ledger of what was done (actions, handoffs and their answers, searches, pages read), compaction notes and how the run ended. The ledger is built from tool results by the harness, never written by the model, and rebuilt identically on replay. A run that fails or is cancelled keeps what it saved. The next run in the chat reads it as "Earlier in this chat you already did this work".

## Repeated searches

The same `web.search` query twice in one run returns the earlier result instead of calling the tool again, logged as `tool.reused`. Small models like to search again; this makes it free.

## Learning happens after the run

A run ends at its reply. A separate function, `agent-learn`, reads the exchange afterwards and keeps up to five facts and an episode summary. The agent is free for your next message as soon as it replies, however slow the learning model is.

## Coordinators

For an agent with the coordinator role, the harness adds the team to the system prompt, ranked by the request, and removes every tool a teammate also has, before the model is ever called. A hidden tool called anyway is refused in its own step. See [Teams](/docs/teams).
