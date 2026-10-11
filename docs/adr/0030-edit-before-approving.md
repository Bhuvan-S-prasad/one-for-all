# ADR-0030: A person can change a held call's written text before approving

- **Status:** Accepted
- **Date:** 2026-10-08
- **Area:** Security
- **Related:** ADR-0013 (policy), ADR-0028 (site answers), ADR-0029 (tools beside an MCP server), ARCHITECTURE.md §6.2, §10.3

## Context

M4's done-when is "the agent drafts an email and waits for your approval before sending", and the design's approval card shows the message with "you can edit before approving". Until now a person could only approve or deny a held call. Denying and asking the agent to try again costs a model turn and a second approval for a one-word fix.

MCP tools describe their arguments only by a JSON Schema, so the card had nothing better to show than the tool name and raw JSON.

## Decision

**A held call's written text can be changed on the card, and the call then runs with the person's version.**

- **Which arguments:** only top-level strings a tool marks `editable`. MCP tools get them from their schema: free-text strings with names like `body`, `subject`, `title`, `description` or `comment`, never ones with an `enum`, `pattern` or `format`, and never IDs or addresses. A recipient isn't editable: changing where something goes is a different decision from changing what it says. Built-in tools mark none yet.
- **Only text the agent wrote:** an argument the call didn't fill can't be added, and one whose text holds a known secret (shown redacted on the card) isn't offered. Saving it would replace the secret with `[REDACTED]`.
- **The API checks it:** `POST /api/approvals/:id` takes `edits` only with `approve`, and only for the approval's `editable` arguments. Unchanged values are dropped. The approval row keeps what changed (`edits`), and the audit log records which arguments, not what they say.
- **The run uses it:** the agent loop merges the edits into the call's arguments and runs it as approved, under the same idempotency key. The executor checks the result against the tool's schema again, and policy still runs (a `deny` still wins). The model's tool result begins "The person changed body before approving, so this ran with their version", and the run log records the decision as `edited` with the argument names.
- **Cards list the arguments** for tools that don't say what they do (`showArgs`; every MCP tool): "Use Notion: Create page" and then labelled fields, with the editable ones last as text boxes.

## Alternatives considered

- **Edit anything, including recipients and IDs:** the card would become a general-purpose form for calls the agent didn't make, and a person could approve a call that skips checks (a new address in a tainted run). Text-only keeps the decision the same: *this* action, with better words.
- **Deny and tell the agent what to change:** another model turn and another approval, on free models with a daily quota.
- **Update the Gmail draft before sending (`drafts.update`):** it needs building MIME, which ADR-0029 avoided. A draft's text is edited when it is written (`create_draft`'s card) or in Gmail itself.

## Consequences

- **Positive:** the design's draft card works for any app whose tools take written text, with one approval.
- **Negative:** the editable-field rule is a name heuristic. A server whose text argument has an unusual name isn't editable (safe), and one named like text that isn't would be editable (a person still sees and approves the value).
- **Follow-up:** built-in tools can opt in (`browser.type`'s `text`, for example) when it proves useful. Telegram and mobile cards (M6) show the same fields.
