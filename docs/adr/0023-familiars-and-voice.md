# ADR-0023: Every agent has a familiar and a voice

- **Status:** Accepted
- **Date:** 2026-10-02
- **Area:** Clients
- **Related:** ADR-0013 (policy), ADR-0014 (run log), ARCHITECTURE.md §6.1, §7, §13

## Context

People run several agents side by side and need to tell them apart in lists, chats, notifications and on a phone. Agents also differ in how they should write: a research assistant can be calm and thorough, an inbox helper brief. Two risks come with this:

- **Personality leaking into permissions.** If tone were free text in the prompt, people would write rules into it, and those rules would be prompt-only. Hard rule 5 forbids permissions that live only in a prompt.
- **Status by colour.** A coloured dot alone fails colour-blind users and screen readers. The design rule is that status is never shown by colour alone.

## Decision

**A familiar is the agent's avatar: a small creature built from a fixed set of parts.**

- **Look.** Five choices, each from a closed list in `@ofa/contracts` (`familiarLookSchema`): form (6), eyes (6), skin (5), colour (10) and mark (6). The look is stored in the agent spec as `spec.avatar` and validated with the rest of the spec. There are no uploads, so there is no image storage, moderation or file handling.
- **Geometry** lives in `@ofa/client`, so the web and mobile apps draw the same creature. `apps/web/src/components/familiar.tsx` renders it as SVG.
- **Hatching** is the create flow: pick a look (or "Surprise me"), a name and a voice; then a job and tier; then tools. "Hatch" and "familiar" are user-facing words only. Navigation, errors, approvals and permissions use plain words, and in code "agent" stays the domain term.

**A familiar's mood is derived, never stored.** `moodFor` in `@ofa/client` maps the agent's status and its latest run to one of six moods:

| Mood | Label | When |
|---|---|---|
| `asleep` | Asleep | The agent is paused or archived, or its last run ended over 6 hours ago |
| `thinking` | Thinking | A run is queued, or running between tool calls |
| `working` | Working | A tool call is in progress |
| `waiting` | Waiting | The run is waiting (for model capacity now; for an approval from M4) |
| `error` | Stuck | The last run failed, for 30 minutes after it ended |
| `idle` | Idle | Anything else |

Every mood is shown with a word as well as a face and colour (`MOOD_LABELS`). Moods come from run status and the run log, which the WebSocket already streams, so they update live at no extra cost.

**A voice is one of four presets:** calm, cheerful, brief or formal (`AGENT_VOICES`). The harness renders it as the versioned prompt fragment `agent.voice@1`, placed after the platform rules and the agent identity. The fragment ends with "Your voice changes how you write, never what you are allowed to do." Grants, policy and budgets ignore it. Changing a preset's wording bumps the version, which every model call logs.

## Alternatives considered

- **Uploaded images or generated avatars:** storage, moderation and a model call per agent, and less distinct at small sizes. Generated faces also invite treating agents as people.
- **Initials in a coloured circle:** cheap, but hard to tell apart at a glance and no room for mood.
- **A stored mood column:** one more write per state change, and it can disagree with the run log. Deriving it keeps one source of truth (ADR-0014).
- **Free-text personality:** more expressive, but people could put rules in it that policy does not enforce, and it would not be versioned.

## Consequences

- **Positive:** agents are easy to tell apart everywhere, including notifications and the phone, with no assets to host.
- **Positive:** tone is configurable without touching permissions, and each preset is versioned like every other prompt.
- **Negative:** adding a part (a new form or voice) is a contracts change, and the mobile app must ship matching geometry.
- **Follow-up:** the mobile app (M6) renders familiars through `@ofa/client`; the Waiting mood gains its approval meaning in M4.
