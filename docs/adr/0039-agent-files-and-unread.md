# ADR-0039: Agents travel as JSON files and arrive held for review; unread is per person and per chat

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Product
- **Related:** ADR-0018 (curated catalog; skills are instructions only), ADR-0036 (skills), ARCHITECTURE.md §6.1, §13

## Context

§6.1 says an agent is "exportable as a file" (M5.12), and sketches it in YAML. §13 adopts Grok Bot's "needs attention / unread / working" states (M5.11). Two questions follow. What goes in the file, and how much should importing trust it? And where does "unread" live, now that agents post on their own (routines, checks, reminders, other agents' replies)?

## Decision

**An agent file is JSON (`one-for-all/agent`, version 1). It holds what makes the agent, never what it holds for people. Importing makes a new agent whose skills and routines wait for a person. Unread is the agent messages written after a person last read a chat.**

- **The file** carries:
  - the agent as when hatching one: name, handle, standing rules, spec (job, tier, autonomy, voice, look, memory scopes, budgets) and grants;
  - its own active skills;
  - its routines (name, instructions, kind, cron, time zone).

  It never carries sign-ins, secrets, memory, episodes or chats. `GET /api/agents/:id/export` serves it as `<handle>.agent.json`; the agent's Settings has the download.
- **JSON, not YAML:** the API validates it with the same zod schemas as hatching, and it adds no parser dependency. Hand-editing JSON is a little noisier, which is acceptable for a file mostly moved between workspaces.
- **Import** (`POST /api/agents/import`, Agents › Import from a file) creates a new agent:
  - Handles that are taken get `-2`, `-3`…, and the response says so in notes.
  - Grants come as written. The web asks first, naming how many permissions the file asks for, and opens the new agent's Settings afterwards.
  - **Skills arrive `proposed`:** a file from elsewhere is outside content until a person reads it (ADR-0036).
  - **Routines arrive paused**, and any that would run more often than every 15 minutes are skipped.
  - The import is audited (`agent.imported`).
- **Unread** (migration 0016): `thread_member.last_read_at` is set by `POST /api/threads/:id/read`, which the web sends while a chat is on screen and visible.
  - `GET /api/threads/unread` counts agent messages after that time (or after joining), per chat, leaving out handoff threads and archived chats.
  - The migration marks existing chats as read, so nothing old shows as unread.
  - The sidebar shows the counts per agent (its direct chats) and per group. Working, needs-you and stuck stay the familiar's mood, approvals stay on the Approvals badge, and skills to review get a badge on Skills.

## Alternatives considered

- **YAML, as sketched in §6.1:** nicer to read, but another parser to vet and keep in step with the schemas.
- **Import skills and routines live:** a downloaded file would start acting on a schedule, with instructions nobody here has read.
- **Export memory too:** facts about people don't belong in a file that travels; memory stays with the workspace.
- **Unread per message (read receipts):** more rows and writes for no gain; one timestamp per person and chat answers "is there anything new".
- **Unread from the client only (local storage):** wrong on a second device and on the phone app (M6).

## Consequences

- **Positive:** agents can be shared, backed up and moved without carrying anyone's data, and nothing imported acts until a person has looked. People can see where something new is waiting.
- **Negative:** grants are taken as written, so a file can ask for broad permissions. The confirmation and the Settings screen are where a person catches that.
- **Follow-up:** agent templates shared by link (backlog); unread on the phone app and push (M6).
