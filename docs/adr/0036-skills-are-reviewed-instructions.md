# ADR-0036: Skills are reviewed instructions, applied by `/name` or `run_skill`

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Runtime
- **Related:** ADR-0013 (taint escalation), ADR-0018 (curated catalog; skills are instructions only), ARCHITECTURE.md §7, §8

## Context

§8 calls procedural memory "how to do a task": `skill` rows with steps, checks and approval points, written by people, by demonstration, or proposed by nightly consolidation. §13 adopts Grok Bot's `/` for skills in chat. ADR-0018 rules out a marketplace, because ClawHub showed what third-party skills bring. A skill that reaches a model's context is an instruction the agent will follow, so who wrote it, and when, matters as much as what it says.

## Decision

**A skill is a named list of steps (instructions only). It reaches a model only while `active`. Anything written by a model after it read outside content, and anything consolidation proposes, waits as `proposed` until a person approves it.**

- **The `skill` table** (migration 0015) holds:
  - a workspace-unique handle (`slug`, used as `/slug`), a name and a description (when to use it);
  - 1 to 20 steps;
  - a status (`active`, `proposed`, `archived`) and a source (`person`, `agent`, `consolidation`);
  - the run it was saved from;
  - an optional agent: without one, every agent may use it.
- **Limit:** 200 skills per workspace.
- **People** manage skills at `/api/skills` (list, create, edit, approve, retire, delete). A person's skill is active at once.
- **`/slug` in a request** applies the skill. It is a word of its own, not inside an address or a path. As the run starts, the harness finds the skill among the agent's own and shared active skills. Its steps go into the system block through the versioned template `harness.skill`, within the plan budget. This works for any trigger, so a routine whose instructions say `/morning-brief` follows that skill. An unknown name is left as text.
- **`run_skill`** (grant "Use skills", on for new agents) returns a skill's steps as a trusted tool result. Its description lists the agent's skills, and it is hidden when there are none.
- **`save_skill`** (grant "Save skills") keeps a procedure the agent just did as its own skill.
  - It is active when the run read no outside content, and proposed otherwise.
  - Saving the same name again replaces the agent's own skill, but can't take a handle a person or another agent holds.
  - The description says it is not for facts or preferences: in the live check, the free model first used it for "note for later".
- **The composer** offers matching skills when a word starts with `/`.

## Alternatives considered

- **Skills as executable code (OpenClaw):** code runs with the agent's permissions and is the supply-chain risk ADR-0018 rejects. Steps still go through tools and policy one call at a time.
- **Every skill needs a person's approval:** this would slow the common case, a person asking their own agent to remember how it did something, without adding safety when the run read nothing from outside.
- **Inject every matching skill automatically:** this spends the plan budget on guesses. The model sees the list in `run_skill`'s description and can ask for one.

## Consequences

- **Positive:** repeated work becomes one word; skills from outside content can't act until a person reads them; routines can share a skill.
- **Negative:** a model can still write a poor active skill from a clean run. People can edit or retire it, and the skills library screen (M5.11) makes that easy.
- **Follow-up:** the skills library and approval screen (M5.11); skills from demonstrations (backlog).
