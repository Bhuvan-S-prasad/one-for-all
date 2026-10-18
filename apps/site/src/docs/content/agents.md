An agent is a named worker with one job. You hatch it on the **Agents** page in three steps: its look, its job, its tools.

## The three steps

**Look.** Give it a name and build its familiar from five parts: form (bloom, blob, drop, totem, ghost, cookie), eyes, skin, colour and a mark. The familiar is how you tell agents apart at a glance; its mood shows what the agent is doing right now (idle, thinking, working, waiting for you, asleep, stuck), always with a word as well as the picture.

**Job.** Say what its one job is, in a few words ("Research", "Reads my email and writes drafts"). Then write its standing rules: the things that stay true across every task, like "Draft in my voice" or "Never contact a customer without asking". Choose:

| Setting    | Choices                          | What it changes                                                                        |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| Role       | Does the work · Leads a team     | A team lead (coordinator) plans and hands work to the others. See [Teams](/docs/teams) |
| Voice      | calm · cheerful · brief · formal | How it writes. Never what it may do                                                    |
| Model tier | fast · standard · strong         | Which class of model it uses. Models are mapped to tiers in configuration              |
| Budgets    | steps and tokens per run         | 40 steps and 120,000 tokens by default                                                 |

**Tools.** Grant the tools it may use. Each grant is one of three modes: **run** without asking, **ask first**, or **off**. Built-in tools (web, memory, files, computer, team) and the tools of apps you connected appear here. For an app you can choose "Reads run, changes ask" in one click. A coordinator also sees a preview of the team it will lead, with what each agent can do.

## One job per agent

Agents work better with one clear job. A "general helper" collects context that helps no one task. Several small agents and a chief of staff to coordinate them beat one agent that does everything.

## Standing rules versus requests

The standing rules sit in every prompt the agent ever gets. Put rules there; put tasks in the chat. A task written into the standing rules is repeated forever.

## Agents as files

**Export** an agent from its settings as a JSON file (`one-for-all/agent`, version 1): its job, rules, look, permissions, its own skills and its routines. **Import** it on the Agents page in any workspace. A file never carries sign-ins, secrets, memory or chats. On import, a taken handle gets `-2`, the agent's skills arrive waiting for your review, and its routines arrive paused.

## Pausing and archiving

A paused agent starts no runs, and its routines skip their times. Its chats and memory stay. Archiving hides it from the lists.
