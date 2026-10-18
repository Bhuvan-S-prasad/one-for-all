You talk to an agent in its chat. Each agent can have several chats, so an old topic stays out of a new task.

## Writing to an agent

Write the way you would to a person. While the agent works, its familiar is the loader: the phase is said in words ("Searching the web", "Waiting for you"), with a timer, so a wait never looks stuck. The steps it has taken so far appear under it.

**Changing your mind mid-task.** Send a follow-up while it works and the agent reads it at its next step, without starting over. Send just "stop" (or "stop now", "cancel") and every run in the chat stops; nothing new starts. Work already done is not undone.

**Your message comes first.** Writing to an agent sets aside its routine work in other chats and starts ahead of queued background work.

## Reading a reply

- **Short replies** read as a chat bubble; **long ones** become a document with a title, an outline and a "Show the rest" fold.
- **Sources.** Pages the agent actually opened are numbered under the reply. A link it wrote but never opened is never shown as a source.
- **Charts.** A reply can hold a bar or line chart, drawn with its values printed and a table view.
- **Files.** Files the agent wrote or sent appear as cards under the reply, ready to download.
- **What it did.** "Worked 2 min 14 s · asked 2 agents · 3 searches" opens into the trail of its steps: one quiet line per step, with the icon of what it used, searches folded together, and failures in plain words. "Everything this run did" opens the full log in Activity.
- **Handed to the team.** When the agent handed work to others, each handoff is a card: who was asked what, how it went, its steps and its answer.
- **Learned.** "Learned 2 things" links to what it remembered; facts from outside content wait for you to confirm them.

When a run stops at its budget, the reply says what it found and what is left, with a **Continue** button. See [Teams](/docs/teams) for how "continue" works.

## Chats and history

**New chat** starts a fresh thread (an empty current chat is reused). **History** lists an agent's chats by last use, with search over every message. Renaming or archiving a chat never changes the order; archiving hides it without deleting it. Unread counts follow you per person and per chat.

## Group chats

A group chat holds you and two to six agents, with one of them as its leader. Every message gets exactly one responder:

```flow
You write in the group | for example "@Writer, tighten the intro"
Mentioned agent? | the first agent you @mention answers
!Otherwise the leader | it answers itself, or hands the work to a member
```

Handoffs show in the group, and each agent's messages carry its name and familiar.

## Activity

The **Activity** page lists every run: what started it, how it ended, its usage, and its full event log, newest first. Every model call, tool call, policy verdict and approval is there.
