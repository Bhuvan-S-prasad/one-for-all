# ADR-0028: Approve a site for one task; the always-human list is classified by name

- **Status:** Accepted
- **Date:** 2026-10-06
- **Area:** Security
- **Related:** ADR-0013 (policy engine, taint escalation), ADR-0027 (address provenance), ARCHITECTURE.md §10.2, §10.3

## Context

Taint escalation (§10.3) holds every outbound call in a run that read outside content. In the M3 end-to-end check, filling and submitting one form took 13 approvals: each click, each field and each key press on the same site. People stop reading cards they see that often, which defeats the point of asking.

The always-human list (§10.2: payments, deletions, permission or password changes, sharing outside) had no way to recognise a tool. Built-in tools can declare it, but MCP servers describe their tools with `readOnlyHint` and `destructiveHint` only, and `destructiveHint` covers overwrites as well as deletions.

## Decision

**A person can approve a site for the rest of one task.** When taint escalation alone holds a call, and the tool can name the site it acts on, the approval card offers a third answer: "Allow on shop.example for this task".

- Tools name their site with an optional `site(args, ctx)` hook. Browser tools use the page they act on, and `browser.open` uses the address it opens. A tool without the hook gets one-off answers only.
- The answer is stored on the approval row (`site`, `scope = 'site'`). The harness keeps the run's allowed sites and passes them with each call. They are rebuilt from memoized answers on replay, and end with the run.
- On an allowed site, policy skips taint escalation, including the address provenance check of ADR-0027. Nothing else changes: grants, the always-human list, the destructive annotation and ask-first rules still apply, and every other site still asks.
- The card offers the answer only when allowing the site would actually let the call run. If a grant set to `approve` or a rule would hold it anyway, the card offers one-off answers only.

**The always-human list is classified by the tool's action words** when a tool doesn't declare `humanOnly`: `delete`, `destroy`, `purge`, `trash` and `erase` mark a deletion; `pay`, `charge`, `refund`, `purchase`, `checkout`, `transfer` and `payout` a payment; `permission`, `password`, `role`, `acl` and `access` a permission change; `share`, `publish`, `invite` and `collaborator` sharing. They are matched as whole words of the snake_case action (`delete_page`, not `deleted_items`), and never for read-only tools. `remove` and `archive` are left out, since removing a label or archiving a message loses nothing. A `human` verdict can't be relaxed by a grant, a rule or a site answer.

## Alternatives considered

- **Approve a whole tool for the run:** broader than the person meant. Approving one click would also allow typing anywhere.
- **Allow sites across runs:** a standing exception to taint escalation. Workspace allow-auto rules exist for standing decisions, and they still never override taint escalation.
- **Classify the always-human list by `destructiveHint`:** it would put every overwrite on the list and miss payments and sharing.

## Consequences

- **Positive:** filling a form on one site takes one decision instead of one per field. Carrying data to any other site still needs a person. Deletions, payments, permission changes and sharing through MCP tools need a person from the first connection, before anyone has reviewed the server's tools.
- **Negative:** classifying by name can catch a harmless tool (`notion.publish_draft` is held) or miss an oddly named one. A tool can always declare `humanOnly`. A misclassified tool only costs a click, and one that slips through still meets grants, rules and taint escalation.
- **Follow-up:** M4.05 can let the catalog review set `humanOnly` per tool. The Approvals page can show which sites a run has allowed.
