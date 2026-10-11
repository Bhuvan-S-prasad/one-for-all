# ADR-0013: Policy engine: strictest verdict wins, with taint escalation

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Security
- **Related:** ADR-0011, ADR-0012, ARCHITECTURE.md §10.2, §10.3

## Context

Agents read content written by other people (emails, web pages, documents, tool output) and can take actions that send data out. Private data, untrusted input and an outbound channel together make prompt injection dangerous. Prompt-level rules are not a security boundary. Grok Bot relies on an LLM reviewer (Auto Review); its own docs describe it as a complement to deterministic controls, and it does not review memory writes.

## Decision

`packages/policy` implements `PolicyEngine`. For every tool call and memory write, each source produces a verdict and the strictest wins:

1. Not granted to this agent → `deny`
2. Always-human list (payments, deletions, permission or password changes, external sharing) → `human`
3. Outbound tool in a tainted run → `approve`
4. Ask-first rule (workspace rules, then personal rules) → `approve`
5. Allow-auto rule, only if nothing above fired → `auto`
6. Otherwise the grant's mode (annotation defaults)

A run becomes **tainted** when it reads untrusted content and stays tainted until it ends. Personal rules can only tighten workspace rules. Proactive background work uses read-only tools only. Facts learned in tainted runs are stored unverified.

## Alternatives considered

- **Prompt-level restrictions only:** not a boundary.
- **An LLM reviewer as the only gate:** non-deterministic and itself open to manipulation. It may be added later as one more verdict source that can only add friction.

## Consequences

- **Positive:** deterministic protection that does not depend on the model resisting an injection.
- **Negative:** tainted runs ask for approval more often. Draft cards (edit, send, discard) keep that friction low.
- **Follow-up:** a red-team eval suite asserting that exfiltration attempts end in `approve` or `deny`.
