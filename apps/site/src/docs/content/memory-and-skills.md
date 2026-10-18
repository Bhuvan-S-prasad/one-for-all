Agents remember facts, keep an episode of every task, follow skills, and know what is due later. You can read and correct all of it.

## Facts

Agents save facts with `remember`, and a short learning pass after each run picks out up to five more. Each fact is filed by whose it is:

| Scope               | Holds                               | Example                                        |
| ------------------- | ----------------------------------- | ---------------------------------------------- |
| You, for this agent | Notes about you, private to you     | "Prefers Linux-friendly laptops"               |
| The workspace       | Team knowledge every agent may read | "Invoices go out on the 1st"                   |
| The agent           | Its own working knowledge           | "The weekly report goes in /workspace/reports" |

Agents find facts with `recall`, a full-text search. Facts learned in a run that read outside content are stored **unverified**: they are not used until you confirm them.

## Reviewing memory

The agent's **Memory** tab, the **Memory** page, Home and the reply that learned something all list facts. Unverified ones wait under **To confirm**, with **Keep** and **Forget**. You see the workspace's facts, each agent's own facts and the notes agents keep about you; never notes about someone else.

## Episodes

Every run that replied leaves an episode: "Asked: … Answered: …", replaced by a one-sentence summary after the learning pass. A run that stopped early records what it did and what was left. The two closest episodes are shown to later runs as "earlier work like this".

## The nightly tidy-up

At 3 at night in your time zone (or when you ask), one fast model call per agent:

- merges facts that say the same thing (the merged fact is verified only if all of them were),
- adds facts its clean recent episodes show,
- proposes skills for your approval.

Rules that need no model expire copies, facts unconfirmed for 30 days, and facts never recalled in 180 days. **Nothing is deleted**: expired facts are kept but no longer used.

## Skills

A skill is a named list of one to twenty steps: instructions an agent follows, never code. Write `/weekly-report` in a message and the agent follows that skill's steps for this request; an agent can also open one itself with `run_skill`.

A skill in a model's context is an instruction it will follow, so who wrote it matters:

| Source                                                         | Status                      |
| -------------------------------------------------------------- | --------------------------- |
| You, on the Skills page                                        | Active at once              |
| An agent's `save_skill`, in a run that read no outside content | Active at once              |
| An agent's `save_skill` after outside content                  | Waits for your review       |
| The nightly tidy-up, and imported agents                       | Always wait for your review |

## Later

Reminders, tasks for later and routines are the agent's memory of the future: see [Routines and reminders](/docs/routines).
