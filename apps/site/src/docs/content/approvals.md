Agents act only through tools you granted, and every call is checked by the policy engine first. When a call needs you, the run pauses and asks.

## When an agent asks

- **The grant says ask first.** You set that tool to "ask first" for this agent.
- **It read something from outside.** Once a run has read a web page, an email, a document or an app's output, it is _tainted_. In a tainted run, every outbound action (sending, posting, clicking, typing, running a command) waits for you, whatever the grant says. A page can carry instructions written by a stranger; this is how they never act without you.
- **It wants to open an address nobody gave it.** In a tainted run, opening a page is outbound too, unless the address came from you or from the run's own search results. A page could ask the agent to visit `evil.example/?email=…`.
- **The action is destructive** (deletes, overwrites), or **always needs a person**: payments, deletions, permission or password changes, and sharing outside.
- **A rule says so.** Rules in Settings make a tool always ask first.

## Answering

The approval card says in plain words what the call would do: "Wants to save a Gmail draft", with the recipient, subject and body.

- **Approve** runs the call as shown.
- **Edit** changes the written text first (a message, a title, a comment; never an address, an ID or a secret), then runs your version. The agent is told what you changed.
- **Deny** refuses it; the agent is told and carries on without it.
- **Allow this site for this task** appears when only taint held a browser call: calls on that site stop asking for the rest of the run. Other sites, destructive actions and the always-human list still ask.

Cards appear in the chat, on Home and on the **Approvals** page. A new request shows a toast wherever you are in the app, and a desktop notification if you turned those on. A request nobody answers expires after a day, and the agent is told.

## Rules

Rules in **Settings** apply on top of grants:

| Rule                 | Who can set it                                             | Effect                                                          |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Ask first            | Owners and admins for everyone; each person for themselves | The tool always waits for a person                              |
| Allow without asking | Owners and admins, for the workspace                       | The tool runs without asking, unless something stricter applies |

A personal rule can only make things stricter. See [Policy and taint](/docs/policy) for the exact order in which the engine decides.
