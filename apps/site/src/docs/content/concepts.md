The words the rest of the docs use, in the order you meet them.

| Term                | Meaning                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Workspace**       | Everything one install holds: people, agents, chats, memory, connections. A self-hosted install is one workspace.                                                        |
| **Agent**           | A named worker with one job. It is a spec stored in the database: job, standing rules, voice, familiar, model tier, autonomy, budgets, role and grants.                  |
| **Familiar**        | An agent's avatar: a creature built from five fixed parts (form, eyes, skin, colour, mark). Its mood follows the agent's latest run and is always shown with a word.     |
| **Hatching**        | Creating an agent.                                                                                                                                                       |
| **Standing rules**  | The agent's description: rules that stay true across every task, always in its context. Task instructions belong in the chat.                                            |
| **Chat**            | A thread between you and one agent. You can have several chats with one agent.                                                                                           |
| **Group chat**      | A thread with you and two to six agents, led by a coordinator.                                                                                                           |
| **Run**             | One execution of an agent: from a trigger (your message, a routine, a handoff) to its reply or stop. Every run is a durable function with an append-only event log.      |
| **Harness**         | Everything around the model in a run: context assembly, the loop, tool dispatch, budgets, stop conditions.                                                               |
| **Tier**            | A class of model: `fast`, `standard` or `strong`, plus a vision chain. An agent picks a tier, never a model by name.                                                     |
| **Tool**            | Something an agent can do, named `app.action`: `web.search`, `files.write`, `gmail.create_draft`.                                                                        |
| **Grant**           | Permission for one agent to use a tool: run, ask first, or off.                                                                                                          |
| **Connection**      | Your sign-in to an app (Notion, Gmail, GitHub…), encrypted in the vault.                                                                                                 |
| **Policy**          | The code that decides, for every tool call, whether it runs, waits for a person, or is refused. The strictest verdict wins.                                              |
| **Taint**           | A run that has read outside content (a page, an email, a tool result from an app) is tainted until it ends. In a tainted run, every outbound action needs your approval. |
| **Approval**        | A held tool call waiting for your answer: approve, edit and approve, or deny.                                                                                            |
| **Sandbox**         | The agents' computer: one container where each agent is its own Linux user, with one way out through an egress proxy.                                                    |
| **Handoff**         | One agent handing a piece of work to another with a brief. The other agent works from the brief alone and its answer comes back.                                         |
| **Coordinator**     | An agent with the coordinator role. It plans, hands work to specialists, and loses the tools a teammate has.                                                             |
| **Capability card** | What an agent can do, in plain words, worked out from its grants: `web: search, read pages`.                                                                             |
| **Chat record**     | Each agent's working record in a chat: its plan, what it did, its notes and how its last run ended. The next run reads it, so "continue" continues.                      |
| **Episode**         | A one-sentence summary of a run, kept so later runs can find "earlier work like this".                                                                                   |
| **Skill**           | A named list of steps an agent follows when you write `/name`. Instructions only, never code.                                                                            |
| **Routine**         | A standing job on a schedule. A routine of kind _check_ only looks and speaks when something needs you.                                                                  |
| **Artifact**        | Output too long for the context, kept in the database and reopened by handle (`artifact://…`). Files an agent writes are kept the same way.                              |
| **Budget**          | The limits of one run: model steps and tokens.                                                                                                                           |
