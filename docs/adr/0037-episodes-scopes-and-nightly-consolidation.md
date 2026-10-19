# ADR-0037: Episodes for every run, facts filed by whose they are, and a nightly pass that only expires

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Runtime
- **Related:** ADR-0013 (taint), ADR-0024 (learning after the run), ADR-0036 (skills), ARCHITECTURE.md §7, §8

## Context

§8 describes four memory stores and three scopes (`workspace`, `agent`, `agent×user`). It also describes a nightly job that rolls episodes into facts, merges duplicates, expires stale facts and proposes skills. Until M5.09:

- every learned fact went to the agent's own scope;
- there were no episodes;
- facts only ever piled up.

The free fast-tier models that do this work think aloud before answering. In the live check, learning calls ran out of output tokens before reaching their JSON, and the parser then read the prompt's own example shape as the answer.

## Decision

**Every run that replies leaves an episode. Learning files each fact by whose it is. Once a night, consolidation tidies each agent's facts and proposes skills, expiring facts rather than deleting them.**

- **Episodes** (`episode` table, migration 0015):
  - **Content:** one per run: a summary, an outcome (`done`, `stopped`, `failed`), and whether the run was tainted.
  - **Writing:** the harness writes it as the run ends (`Asked: … — Answered: …`, no model call). The learning pass replaces the summary with the model's own sentence.
  - **Recall:** the two best full-text matches for this agent and person go into the memory block as "Earlier work like this". Tainted episodes are never recalled or consolidated, since their summaries may carry someone else's words.
  - **Retention:** episodes are dropped after 180 days.
- **Scopes:** extraction (`memory.extract@4`) groups facts into `person`, `team` and `work`.
  - They go to `agent_user`, `workspace` and `agent` respectively, each only if the agent may use that scope, otherwise to its own memory.
  - Grouped lists sorted better than a label on each fact. The same fact twice is kept once; at most five per run.
- **Small models' JSON:**
  - Answers are read from the last complete JSON object with the expected keys. Placeholder text (`...`, `<…>`) counts as no value.
  - Background calls may ask for less thinking (`LLMRequest.reasoning`, which OpenRouter maps to `reasoning.effort`). Learning uses `none` (about 130 tokens and 5 seconds, against 3,000+ tokens and no answer before) with 4,000 tokens of room. Consolidation uses `low` with 6,000.
- **Nightly consolidation** (`memory-consolidate`, hourly): it handles each workspace where it is 3 at night (its `time_zone`) and whose last pass is at least 20 hours old, acting as the workspace owner. `POST /api/memories/consolidate` asks for one now (owner or admin).
  - **One model call per agent** (`memory.consolidate@1`) reads up to 60 of its facts (as `f1…fn`) and 30 new untainted episodes. It returns:
    - **merges:** the merged fact is verified only if every fact it replaces was, and the old ones expire;
    - **up to 5 new facts:** from untainted work only, and verified only if every fact the call was shown was verified (an unverified one could come back reworded as "new"; amended 2026-10-19 after the security audit);
    - **up to 2 skill proposals:** status `proposed`; a person approves them (ADR-0036).
  - **One pass over the shared workspace facts** merges only.
  - **Rules that need no model:**
    - copies of the same fact for the same owner expire (the oldest, preferably confirmed, stays);
    - unconfirmed facts expire after 30 days;
    - facts never recalled expire after 180 days (preferences stay).
  - Recall now records `last_recalled_at`, so facts in use stay.
- **Nothing is deleted** by consolidation; expired facts can be traced.

## Alternatives considered

- **An episode written by its own model call per run:** this doubles the fast-tier quota. The deterministic summary costs nothing, and the learning call already in place improves it.
- **Hard deletes for merged and stale facts:** a bad merge would lose what a person confirmed. Expiry hides the fact and keeps it.
- **Let the model re-scope existing facts at night:** a model moving a person's private note into shared workspace memory is a privacy risk. Facts keep the scope they were written with.
- **A fixed UTC hour:** "night" would be lunchtime for half the world. The workspace's own zone decides.

## Consequences

- **Positive:**
  - Agents remember earlier work as well as facts.
  - Memory shrinks instead of growing without end.
  - Team knowledge is shared with every agent that may read the workspace scope.
  - Skills emerge from repeated work, behind approval.
- **Negative:**
  - Without thinking, a free model still files some team facts as the agent's own. They aren't lost, but other agents don't see them.
  - Consolidation spends one model call per agent with memory each night: about a dozen in the dev workspace.
  - Finding due workspaces needs the owner connection (`DATABASE_MIGRATION_URL`).
- **Follow-up:**
  - The memory view with episodes and proposed skills (M5.11).
  - Let a person move a fact between scopes.
  - pgvector recall for episodes once embeddings are configured.
