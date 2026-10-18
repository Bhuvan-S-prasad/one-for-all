One-for-All is a self-hosted platform for a team of AI agents that work for you. Each agent has one job, its own computer to work on, the tools you grant it, and a memory that improves with use. You talk to them in a web app on your own machine, and they come back to you when something needs your approval.

It is modelled on the "AI teammate" products that appeared in 2026, with two differences: it runs on your own hardware, and it is built to cost nothing to run beyond the model calls you make with your own OpenRouter key. Free models work.

## What you get

- **Agents with one job each.** You hatch an agent by giving it a job, standing rules, a voice and a familiar (its avatar). It keeps that job across every chat.
- **A computer per agent.** Each agent works as its own Linux user on a light desktop: a browser, a terminal, files, Python, and Word and Excel files. You can watch it and take over the mouse.
- **A team that hands work around.** A chief of staff plans the work and hands each piece to the agent that can do it. Agents can share a group chat with you.
- **Approval before anything leaves.** Agents use only the tools you grant. Once an agent has read anything from outside, every send, post or click waits for you, and you can edit a draft before approving it.
- **Work that continues.** A run that stops says what it did and what is left; "continue" carries on from a record of the work instead of starting over.
- **Work on a clock.** Routines run on a schedule in your time zone, quiet checks speak only when something needs you, and agents set their own reminders and tasks for later.
- **A memory you can read.** Facts, an episode for every task, and reusable skills. Anything learned from outside content waits for you to confirm it.
- **Apps through MCP.** Connect Notion, Gmail, GitHub, Linear and Google apps once; grant each agent the tools it needs.

## Principles

Five rules shaped every part of the system.

| Principle                 | In practice                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ports and adapters**    | Anything that could change (the model provider, the sandbox, the vault) sits behind an interface in `packages/core`. Adapters are chosen in one file. |
| **Durable by default**    | Every agent run is a chain of durable steps. State lives in Postgres, never in process memory, so a restart resumes work instead of losing it.        |
| **Security in code**      | Permissions are enforced where tools execute and where rows are read. Prompts describe the rules; they never enforce them.                            |
| **Tenant-ready**          | Every row carries a workspace, and every call carries a tenant context. A self-hosted install is one workspace.                                       |
| **The run is the record** | Each agent run writes an append-only event log. Activity, traces, evals and crash recovery all read from it.                                          |

## Where to go next

- [Install it](/docs/quick-start) with Docker in three commands.
- Read the [concepts](/docs/concepts) so the rest of the docs read easily.
- See [how a task runs](/docs/a-run), end to end through every layer.
- Browse [every decision](/docs/decisions), with what was rejected and why.
