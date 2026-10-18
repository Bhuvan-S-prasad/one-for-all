Free models have small context windows and get worse as prompts grow. So every prompt is assembled from **typed blocks**, each with a token budget worked out from the model's real context window. Blocks run from stable to volatile, so providers with prompt caching can reuse the start.

## The budget, at a 32,000-token window

| Group    | Block                | Holds                                                                   | Tokens |
| -------- | -------------------- | ----------------------------------------------------------------------- | -----: |
| Stable   | Platform rules       | Safety rules, tool-use norms, output format; identical bytes every call |  1,200 |
| Stable   | Agent identity       | Job, standing rules, voice                                              |  1,000 |
| Stable   | Tool schemas         | The granted tools, in a stable order, about 20 at most                  |  4,000 |
| Per task | Task and plan        | The latest request, the plan, notes from compacted steps                |    800 |
| Per task | Team                 | A coordinator's ranked team and its rules                               |  1,000 |
| Per task | Retrieved memory     | Top facts, two close episodes, a skill named with `/name`               |  2,500 |
| Per task | Earlier in this chat | The agent's chat record                                                 |  1,500 |
| Volatile | History              | A structured summary and the recent turns verbatim                      | 10,000 |
| Volatile | Outside content      | Pages, emails, documents, tool output, wrapped and labelled             |  6,500 |
| Reserve  | Output               | The reply and its tool calls; never spent on input                      |  6,000 |

The team block and the chat record take their tokens from history, so the window never grows.

## Techniques

- **Artifacts instead of dumps.** Output longer than 12,000 characters is stored as an artifact (up to 10 MB). The context gets its start and a handle, `artifact://<id>`, which the agent reopens with `artifacts.read` when it needs more.
- **Structured compaction.** When the prompt passes 70% of the input budget, older turns become notes: decisions made, facts learned, open items, artifacts produced. The notes sit in the task block as the agent's own, never as a message in the conversation.
- **Read in chunks.** `web.read_url` returns 6,000 characters at a time and says how to read on, so a few long pages don't fill a small window.
- **Scoped handoffs.** A teammate starts from a brief, never the parent's transcript.
- **Work carries across runs.** The chat record carries the plan and what was done into the next run in the chat.
- **Small tool lists.** Grants filter the tools, and apps with many tools load on demand with `load_toolkit`.
- **Provenance labels.** Outside content is always wrapped as `<untrusted source="…">`. Labels alone don't stop injection; they drive taint tracking, which does.
- **A capability roster, not a guess.** A coordinator reads what each teammate can do, from its grants.

## Versioned prompts

Every piece of wording is a template with an id and a version. A change in wording bumps the version, and every model call logs the versions it was built from, so a trace or an eval result ties to the exact words.

| Template                 | Version | Used for                                  |
| ------------------------ | ------: | ----------------------------------------- |
| `platform.rules`         |       3 | The rules every agent follows             |
| `agent.identity`         |       1 | The agent's name, job and standing rules  |
| `agent.voice`            |       1 | One of four voices                        |
| `harness.task`           |       2 | The request and plan; the budget warning  |
| `harness.session`        |       2 | "Earlier in this chat": the chat record   |
| `harness.team`           |       5 | A coordinator's team and rules            |
| `harness.handoff`        |       2 | A teammate reading its brief              |
| `harness.final`          |       1 | The last call at a budget stop            |
| `harness.compaction`     |       2 | Turning old turns into notes              |
| `harness.steering`       |       1 | A message you sent while the agent worked |
| `harness.agent_message`  |       1 | A message from another agent              |
| `harness.routine`        |       1 | A routine's instructions                  |
| `harness.check`          |       2 | A quiet check                             |
| `harness.scheduled_task` |       1 | A task the agent set for itself           |
| `harness.skill`          |       1 | The steps of a skill                      |
| `harness.screenshot`     |       1 | Reading a screenshot                      |
| `memory.extract`         |       4 | The learning pass after a run             |
| `memory.consolidate`     |       1 | The nightly tidy-up                       |
