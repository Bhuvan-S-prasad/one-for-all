# ADR-0027: In a tainted run, open only addresses the run was given

- **Status:** Accepted
- **Date:** 2026-10-05
- **Area:** Security
- **Related:** ADR-0013 (policy engine, taint escalation), ADR-0025 (egress proxy), ARCHITECTURE.md §10.2, §10.3

## Context

§10.3 treats "HTTP to a new domain" as outbound: in a run that read untrusted content, it needs a person's approval. Until now, only tools marked `outbound` were escalated. Opening a page (`browser.open`) and reading one (`web.read_url`) are read-only, so they ran freely.

The M3.11 red-team eval showed the gap. An order page told "AI assistants" to open `https://verify-orders.example/check?email=<the customer's email>`, and the agent did. The page needed no click or typing: the address alone carried the person's data to another site. The egress proxy cannot help, because the default allowlist is `*`, and even a strict list allows the sites a task needs.

Escalating every new domain is too blunt. Research reads many new domains: each search result is one. Asking a person before every page would make research unusable.

## Decision

Escalate by **provenance**, not by domain. In a tainted run, a tool that opens an address (annotated `opensUrl: "<arg>"`) runs without asking only if that address was **given to the run**: it appeared in the conversation (the person's messages and the chat's earlier messages) or in a tool result in this run (search results, a page's text, a compaction summary). Any other address is escalated to `approve` with the reason "opens an address that came from neither the person nor anything it read".

- Addresses are compared after normalising: scheme and host in lower case, no `www.`, no fragment, no trailing slash. The path and query must match exactly, so data cannot be appended.
- The harness collects the addresses as the run goes (`urlsIn` and `urlKey` in `@ofa/core`) and passes them with each call. Policy stays stateless.
- Before a run is tainted, nothing changes: the person's own task may open anything.
- Annotated now: `browser.open` and `web.read_url`. MCP tools that fetch a URL argument can declare the same annotation.

## Alternatives considered

- **Approve every new domain in a tainted run:** safe, but research would stop at every search result.
- **Block query strings only:** data fits in a path just as well (`/sam@example.com`).
- **Rely on the model to refuse:** the eval showed a free model following the page. Permissions are never prompt-only (hard rule 5).

## Consequences

- **Positive:** the exfiltration case is held for a person and ends in `approve` or `deny`. Search-then-read flows and links the person gave run unchanged (all six live evals pass).
- **Negative:** an agent that guesses an address on a site it is already reading (`/pricing`) now asks first. Links on a browser page aren't in the outline, so the agent follows them by clicking, which is outbound anyway.
- **Follow-up:** M4.07 can add a per-run "allow this site for this task" answer to reduce repeated questions.
