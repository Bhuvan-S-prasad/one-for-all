# Plan: a conversation-first shell

**Status:** built (2026-11-08), as recorded in [ADR-0052](../adr/0052-conversation-first-shell.md). Two changes from this plan: the endpoint is `GET /api/threads/conversations`, and Home became **Overview** (`/overview`, first in the Workspace menu) instead of merging into Activity. The ADR is the record; this file is the original proposal.
**Goal:** the signed-in web app looks like a messenger. The sidebar lists your conversations and nothing else; the screen shows one conversation. Everything else (agents, approvals, routines, skills, memory, activity, connections, settings) is one click away but never on screen by default.

## 1. What's wrong today

The sidebar in [app-shell.tsx](../../apps/web/src/components/app-shell.tsx) carries four separate jobs at once:

| Block | Items | Problem |
|---|---|---|
| Search | ⌘K button | Fine; keep it. |
| Main nav | Home, Agents, Activity, Approvals, Routines, Skills, Memory, Connections (Soon), Settings | Nine links, three badges and a lime active pill. That's half the sidebar and it's the loudest thing on screen, though most of these pages get opened once a week. |
| Agents | Up to 8 agents with mood words | Agent names, not conversations: no last message, no time, no order by activity. |
| Groups | Up to 6 group chats | A second list with its own heading and empty-state box. |

On phones there's a top bar with a 7-item menu **and** a 4-tab bottom bar **and** an "Ask" button. The chat itself (the product) gets what's left.

The reference (Grok's interface) does it the other way round. One list of conversations, each with an avatar, a name, a time and a one-line preview. "Needs you" shows up **inside the conversation** as an "Action needed" card, not as a separate Approvals page. We already have those cards (ADR-0030, approve-or-deny and draft cards in chat), so most of the design is already there.

## 2. The design

### 2.1 Desktop

```
┌──────────────────────────────┬──────────────────────────────────────────────┐
│ ◉ One-for-All            ✎  │ (●) Sales Outbound                  🖥   ⋯  │
│ ┌──────────────────────────┐ │──────────────────────────────────────────────│
│ │ 🔍 Search          ⌘K   │ │                                              │
│ └──────────────────────────┘ │        …messages…                            │
│                              │                                              │
│ (●) Chief         Yesterday  │  ┌ Computer ─────────── ✳ Action needed ┐   │
│     booked the venue and …   │  │ Sign in to Salesforce so I can …     │   │
│ (●) Sales Outbound  8:29 AM ●│  │ [ live screen ]                      │   │
│     Checking what's conn…    │  │ [Take over] [I'm done]               │   │
│ (●) Inbox Manager   5:29 AM  │  └──────────────────────────────────────┘   │
│     sent. inbox at zero, …   │                                              │
│ (●●) Offsite crew   2:29 AM  │                                              │
│     that leaves the pipel…   │ ┌──────────────────────────────────────────┐ │
│                              │ │ +  Message Sales Outbound            🎙 │ │
│ (B) Bhuvan               ⌄  │ └──────────────────────────────────────────┘ │
└──────────────────────────────┴──────────────────────────────────────────────┘
```

**Sidebar (≈300 px, one job: conversations)**

- **Top row:** brand mark, then **✎ New chat**. It opens a small picker (agents, "New group…", "Hatch an agent…"), which replaces the two "+" buttons under the Agents and Groups headings.
- **Search:** unchanged. ⌘K opens the palette, which is still the fast way to reach every page.
- **One conversation list:** every agent's direct chat and every group chat, merged and sorted by last activity. Each row has:
  - **Avatar:** the familiar, with its mood animation kept, so "working" stays visible without a word. A group shows two or three overlapping familiars, as in the reference.
  - **Name and time:** "8:29 AM", "Yesterday", "Mon", "12 Oct".
  - **Preview:** one line of the last message, prefixed "You: " when you wrote it.
  - **State on the right, at most one, in this order:**
    1. *Action needed*: a lime pip, with "Action needed" as its accessible name. It means an approval or a takeover is waiting in that chat.
    2. *Stuck*: the familiar shows the error mood, and the preview reads "Stopped: <reason>" in the destructive colour.
    3. *Unread*: a count.
  - Status is never shown by colour alone (CLAUDE.md design rules), so each state also has a text or icon cue.
- **Active row:** a quiet filled background (`bg-white/[0.07]`), **not** lime. Lime stays reserved for actions and "needs you", as the design tokens intend; the current lime nav pill breaks that rule.
- **Bottom:** your initial and name. Clicking opens the **Workspace menu** (§2.3).
- **Nothing else:** no section headings, no eyebrow labels, no badges on nav items, and no list cap of 8 agents and 6 groups. The list scrolls.

**Conversation header:** the familiar and name on the left. On the right there are only two controls:

- 🖥 opens the computer panel.
- **⋯** opens the agent menu: New chat, Chat history, Memory, Routines for this agent, Edit agent, Pause or Resume.

Pause, "New chat" and the other buttons that sit in today's `ChatHeader` move into ⋯.

**Empty main area:** `/` opens your most recent conversation. In a new workspace (no model key, or no agents) it shows the existing setup checklist instead.

### 2.2 Phone

```
┌───────────────────────┐      ┌───────────────────────┐
│ (B)   Chats     🔍  ✎ │      │ ←  (●) Sales Outbound ⋯│
│───────────────────────│      │───────────────────────│
│ (●) Chief   Yesterday │ tap  │   …messages…          │
│     booked the venu…  │ ───► │   [Action needed card]│
│ (●) Sales Out… 8:29 ● │      │                       │
│     Checking what's…  │      │ ┌───────────────────┐ │
│ …                     │      │ │+ Message …     🎙 │ │
└───────────────────────┘      └───────────────────────┘
```

- The list is the phone's home screen, and a conversation opens full screen with a ← back arrow.
- **Removed:** the bottom tab bar, the floating "Ask" button, and the 7-item top-bar menu.
- The avatar (top left) opens the same Workspace menu as on desktop, as a bottom sheet.

### 2.3 Where everything else goes

| Today (sidebar nav) | After | How you reach it |
|---|---|---|
| Home dashboard | The "Working now", "Recent results" and quota cards move to the top of **Activity**. The setup checklist stays on `/` for new workspaces. | Workspace menu → Activity; `G R` |
| Agents | Workspace menu → **Agents** (the roster, hatch, edit). One agent's pages are also under that chat's ⋯. | menu; `G A`; palette |
| Approvals | **In the conversation**, as today's cards, plus the "Action needed" pip on the row. The page stays as **Needs you** in the Workspace menu with a count, for approvals across all agents. | row pip; menu; palette |
| Routines, Skills, Memory | Workspace menu. Skills shows its "to review" count there. | menu; palette |
| Activity | Workspace menu | menu; `G R` |
| Connections | Workspace menu; hidden until it's built, rather than shown dimmed with "Soon" | — |
| Settings, theme, shortcuts, sign out | Workspace menu (theme as today's three-way switch) | menu; `G S` |

**Workspace pages get their own sidebar mode.** On any of these pages, the sidebar swaps the conversation list for a short section list (Needs you, Agents, Activity, Routines, Skills, Memory, Settings) under a "← Chats" link, the way Slack and Linear do with settings. It's one sidebar with two modes, not two sidebars. **URLs don't change**, so links, shortcuts, notifications and tests keep working.

**Attention still reaches you:**

- The tab title count ("(2) One-for-All") stays.
- Browser notifications for approvals stay (`useApprovalAlerts`).
- When something needs you in a chat you're **not** looking at, the row's pip shows and the Workspace avatar gets a small lime dot.

## 3. Motion and polish (from the design-engineering rules)

- **Rows:** a hover background with a 150 ms `ease` colour change, gated behind `@media (hover: hover)`. Press feedback is `scale(0.98)`. No row entrance animations: the list is seen dozens of times a day.
- **Re-ordering:** a conversation that jumps to the top on a new message moves with a 200 ms transform (FLIP), not a jump cut, and doesn't animate under `prefers-reduced-motion`.
- **Menus:**
  - The Workspace menu, the ⋯ menu and the New chat picker scale from `0.96` with opacity over 160 ms, using `cubic-bezier(.23,1,.32,1)`.
  - Each `transform-origin` sits at its trigger: bottom-left for the Workspace menu, top-right for ⋯.
  - The exit is faster than the entrance (100 ms).
- **No animation on keyboard-driven actions:**
  - The ⌘K palette and `[` (hide the sidebar) open and close instantly.
  - `[` now hides the sidebar completely instead of folding it to an icon rail. A rail of eight familiars is clutter, and the reference has none.
- **The "Action needed" pip** pulses once when it first appears, not continuously.
- **Spacing and type:** rows are 64 px tall, with the name in 15 px semibold Geist and the preview in 13.5 px muted. Times use tabular figures in Geist Mono at 12 px.

## 4. Backend work this needs

The sidebar needs data that doesn't exist yet. Threads are listed per agent (`useAgentThreads`), and the stored preview is the *first* message the person wrote, not the last message.

1. **Contract** (`packages/contracts/src/threads.ts`): add a `conversationSchema` with these fields:
   - `threadId`, `kind` (`direct` | `group`), `title`, `agentIds`.
   - `last`: `{ snippet, author: "user" | "agent", agentId?, at }` or null.
   - `unread`, `needsYou` (the count of pending approvals and takeovers in that thread), and `stuck` (boolean).
   - Plus `conversationListSchema`.
2. **Repo** (`packages/db/src/repos/threads.ts`): `listConversations(tenant)`.
   - Rows: each agent's most recent non-archived direct thread, plus every group thread.
   - Each row joins its last message (with a lateral join and a snippet cut in SQL), the unread count, and pending approvals.
   - It takes a `TenantContext`, and RLS stays on.
   - Older direct chats stay in each agent's History, reached from ⋯.
3. **API:** `GET /api/conversations` in `apps/api/src/routes/threads.ts`.
4. **Client:** `useConversations()` in `@ofa/client`, invalidated by the realtime events we already send (`message.created`, the run status events, and the approval events). No new WebSocket messages are needed.
5. **Tests:**
   - A db integration test: ordering, archived threads excluded, tenant isolation.
   - An API integration test: the shape, and an approval that shows as `needsYou`.
   - A unit test for the row-state priority (action needed > stuck > unread).

## 5. Docs (CLAUDE.md "Keeping docs current")

- **ADR-0052 "A conversation-first shell".** It records the decision and **amends ADR-0039**: approvals and skills-to-review lose their nav badges and move to the conversation row, the Workspace menu and the Needs you page.
- **ARCHITECTURE.md:** add a line under the UX section and a decision-log entry.
- **Design canvas:** add a "Shell v2" artboard (desktop and phone). CLAUDE.md says screens follow the canvas, so it should be updated first or at the same time.
- **The tracker:** add a "Shell" phase with the tasks below.
- **`apps/learn`:** no page covers the shell yet, so nothing goes stale. A short "How the web app is laid out" page can come with LN.05.

## 6. Tasks, in order

| # | Task | Done when |
|---|---|---|
| CS.01 | ADR-0052, the ARCHITECTURE note, the canvas artboard, the tracker phase | The documents are merged and you've approved the artboard |
| CS.02 | Conversations: contract, repo, route and hook, with tests | Integration tests pass; the endpoint returns direct and group rows with `last`, `unread` and `needsYou` |
| CS.03 | The new sidebar: conversation rows, New chat picker, search, the bottom user row; the old nav, Agents and Groups blocks and the icon rail removed | The sidebar shows only conversations; `[` hides it; it works by keyboard alone |
| CS.04 | The Workspace menu, and the sidebar's workspace mode (section list + "← Chats") for the management pages | Every old destination is reachable in ≤ 2 clicks; the `G *` shortcuts and the palette still work |
| CS.05 | Conversation header: familiar + name, 🖥, ⋯ menu; `ChatHeader` controls moved into ⋯; the same header for group chats | Pause, new chat, history, memory, routines and edit all work from ⋯ |
| CS.06 | Attention: the row pip, the stuck preview and the unread count; the menu dot; Home cards moved into Activity; `/` opens the latest conversation | An approval raised in a background chat shows its pip live; the tab title count is unchanged |
| CS.07 | Phone: the list as home, full-screen chats with back, the Workspace bottom sheet; the bottom tab bar and Ask button removed | Checked at 390 px: no horizontal scroll, 44 px targets |
| CS.08 | Polish and checks: the motion in §3, reduced motion, light theme, screenshots at 1440/768/390, typecheck, lint, unit and integration tests | Everything passes; before and after screenshots in the session log |

Estimate: CS.02 and CS.03 are the bulk. Everything else is moving existing pieces.

## 7. Decisions I've made (say if you want them the other way)

1. **One row per agent, not per thread.** An agent's older chats live in ⋯ → Chat history. This keeps the list short and matches the reference. The alternative, every thread as its own row, gets long fast because agents start new chats often.
2. **The Home dashboard merges into Activity** instead of staying a separate page. With a messenger layout, `/` should land you in a conversation.
3. **The sidebar hides completely instead of folding to an icon rail.**
4. **URLs stay the same.** Only the layout around them changes, which keeps the risk low and the change reviewable.

## 8. Risks

- **Routines, Skills and Memory become less visible.** Mitigations:
  - The Workspace menu shows their counts.
  - Empty-state hints in chat, e.g. "Run this every morning? Make it a routine."
  - The palette.
- **An approval in an agent that has no chat yet,** such as one raised by a routine. The routine's thread becomes that agent's direct conversation row, so the pip still has somewhere to show. The Needs you page covers anything else.
- **Existing screenshots and evals that click the sidebar nav** need updating in CS.08.
