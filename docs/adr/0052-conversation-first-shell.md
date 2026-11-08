# ADR-0052: The web app is conversation-first; the sidebar lists conversations and nothing else

- **Status:** Accepted
- **Date:** 2026-11-08
- **Area:** Clients
- **Related:** ADR-0039 (unread; amended here), ADR-0030 (cards in chat), ARCHITECTURE.md §13, [docs/planning/CLEAN-SHELL.md](../planning/CLEAN-SHELL.md)

## Context

The signed-in shell (UX.03) put nine pages in the sidebar (Home, Agents, Activity, Approvals, Routines, Skills, Memory, Connections, Settings), each with badges, above a list of up to eight agents and a separate list of up to six group chats. On phones it added a top-bar menu, a bottom tab bar and an Ask button. Most of those pages are opened rarely, yet they were the loudest part of the screen, and the agent list showed names, not conversations: no last message, no time, no order by activity.

Grok Bot, the reference §13 already follows, does the opposite: one list of conversations, and what needs you shows inside the conversation. We already show approvals and takeovers as cards in the chat (ADR-0030), so the pages are a second path, not the main one.

## Decision

**The sidebar lists conversations only. Everything else lives behind a Workspace menu, the ⌘K palette and the chat's ⋯ menu.**

- **The conversation list** has one row for each agent's latest direct chat and one for each group chat, ordered by last activity. Each row shows:
  - the familiar (a group stacks its members' familiars), the name, a time and a one-line preview of the last message;
  - at most one state, in this order: *action needed* (an approval waiting in that chat), *stuck* (the last run failed), then the unread count.

  Older chats with an agent stay in its Chat history.
- **`GET /api/threads/conversations`** serves the list: the last message, unread, `needsYou` and `stuck` per thread, in one tenant-scoped query. The client refreshes it on the realtime events it already receives.
- **The Workspace menu** opens from the person's name at the bottom of the sidebar. It holds Overview, Agents, Activity, Routines, Skills, Memory and Settings, plus theme, keyboard shortcuts and sign out. On those pages the sidebar shows the same section list under "← Chats". Approvals keep their page, reached from the palette and notifications.
- **Pages keep their URLs and shortcuts,** except Home's dashboard, which moves to `/overview`. Only the layout around the pages changes.
- **The chat header** has the familiar and name, the computer button and a ⋯ menu that holds the agent's actions.
- **`/` opens the latest conversation** on wide screens and is the conversation list on phones. A new workspace sees its setup checklist there. The old Home (needs you, ask an agent, working now, recent results, quota) becomes **Overview** (`/overview`), first in the Workspace menu.
- **The sidebar hides** with `[` instead of folding to an icon rail.
- **On phones** the conversation list is the home screen and a chat opens full screen. There is no bottom tab bar.
- **Amends ADR-0039:** approvals and skills to review no longer badge sidebar items. Approvals show as the row's *action needed* state and as a count on Overview in the Workspace menu; skills to review as a count on Skills there. The tab-title count and approval notifications stay.

## Alternatives considered

- **Keep the nav but make it collapsible:** still two jobs in one column, and the conversations stay a list of agent names.
- **One row per thread:** agents start new chats often, so the list grows fast and the same agent shows up many times.
- **Move the pages to a top bar:** the screen gains a second chrome strip, which is what this decision removes.

## Consequences

- **Positive:** the chat is the screen. What needs you shows where it happened, and the list says who spoke last and when.
- **Negative:** Routines, Skills and Memory are one click further away. The Workspace menu shows their counts, and the palette and `G` shortcuts reach them directly.
- **Follow-up:** the design canvas gets a "Shell v2" artboard; the Expo app (M6) follows the same layout.
