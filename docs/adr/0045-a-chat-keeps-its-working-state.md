# ADR-0045: A chat keeps each agent's working state across runs

- **Status:** Accepted
- **Date:** 2026-10-18
- **Area:** Runtime
- **Related:** ADR-0014 (the run), ADR-0032 (delegation), ADR-0037 (episodes), ADR-0013 (taint), ADR-0027 (address provenance), ARCHITECTURE.md §6.2, §7, §8

## Context

A run loads its chat as the last 30 messages, text only. Everything else a run learns lives in its own loop and is gone when it ends: tool results, its plan (`todo.write`), its compaction notes, the handoffs it made and what came back, the files it wrote. A follow-up works only when the final reply happened to restate what matters.

A run that stops early leaves almost nothing. In the live run of 2026-10-18 the chief of staff reached its token budget after 22 tool calls and a Gmail draft. Its chat held "I stopped before finishing: I reached my token budget for one task." Asked to "continue where you left off", the next run had a 2,300-token prompt with no trace of the work, its episode read "Asked: … Stopped: token budget", and it searched the same laptops again from the start until the budget ran out once more.

This is the same for every agent in every chat. It is not a model weakness: no model can continue work it is never shown.

## Decision

**Each agent keeps a working record per chat, saved as the run goes and shown to its next run in that chat.**

- **The record** (`thread_state`, one row per thread and agent, row-level security like every tenant table):
  - **plan:** the latest `todo.write` list;
  - **done:** a ledger of what happened, written by the harness from tool results, not by the model: actions that changed something (`gmail.create_draft → Draft saved …`), handoffs with their status and answer, searches made and pages read;
  - **notes:** the run's compaction notes, when it had any;
  - **how the last run ended** (its stop reason) and which run wrote it.
- **Saved as the run goes.** The loop saves the record in its own durable step after each model step that changed it, so a run that stops, fails or is cancelled keeps what it did. Each run starts from the previous record and adds to it; the ledger keeps its latest 40 entries, each cut short.
- **Shown to the next run.** A block "Earlier in this chat" (`harness.session`, versioned) sits in the system prompt with the plan, the ledger and the notes, within about 1,500 tokens at the 32k window, taken from the history budget. It says not to redo finished work and to reuse what was found. If the last run stopped before answering, its open plan items become the new run's plan.
- **Taint is kept.** Ledger entries hold the harness's own words and the agent's arguments; a result is quoted only when it came from inside the system. A handoff answer that came from outside content is kept wrapped as outside content, and a run that loads such a record starts tainted. Addresses in a record written by a tainted run don't count as given (ADR-0027).
- **Stopping says where it got to.** A run stopped by its token or step budget makes one last call without tools (`harness.final`): "write your answer now from what you have, and say what you didn't get to". Its reply is that answer, then what is left from the plan and "Reply continue to pick up from here". A handoff's answer to the agent that asked therefore carries findings, not only "I stopped". If that call fails, or the run stopped in a loop, the reply lists what was done from the record instead. Its episode records the same instead of "Stopped: …". (Amended 2026-10-18 after the live check, TC.09: the 80% warning alone didn't stop a researcher searching until its budget ran out with nothing written, so its coordinator got nothing back.)
- **Warned before the end.** From 80% of the token or step budget, the task block tells the agent to finish the current item and answer (`harness.task@2`).
- **No repeated searches.** The same `web.search` query twice in a run returns the earlier result (`tool.reused` in the run log) instead of calling the tool again.

## Alternatives considered

- **Put the run's tool results in the chat as messages:** people would read pages of tool output, and history would fill the window at once.
- **A model-written summary of the steps at every stop:** costs a call to describe work rather than finish it. The last call asks for the answer instead, and only at a budget stop; the ledger, exact and free, covers the rest.
- **Derive the record from the run log afterwards:** the run log has previews only, and a cancelled run's function never reaches a later step. Saving as the run goes covers every ending.
- **Keep it on the run row:** the next run would read the latest run of that agent in the chat. A row per thread and agent is simpler to read, merge and clear.

## Consequences

- **Positive:** "continue" continues, after a budget stop, a failure or a Stop; follow-ups in any chat can use what was found before; stop replies say what was done.
- **Negative:** one more database write per model step that changed the record; up to 1,500 tokens of each prompt; a chat where an agent once handed work to an agent that read outside content keeps starting tainted for that agent.
- **Negative:** what a page or email said is not in the record, only that it was read and where. A continued run reopens the pages it needs from the list instead of searching again (the `continuity.continue-after-budget` eval checks it doesn't search); its own compaction notes, when it had any, carry the facts.
- **Follow-up:** TC.02 (the record), TC.03 (the block and plan carry-over), TC.04 (stop replies, the warning, reused searches, episodes), TC.08 (an eval that continues after a budget stop without redoing work).
