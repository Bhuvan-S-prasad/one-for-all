# ADR-0018: Curated catalog, no open skill marketplace

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Security
- **Related:** ADR-0011, ADR-0013, ARCHITECTURE.md §9, §10

## Context

OpenClaw's ClawHub skill registry was flooded with malware: 341 malicious skills were found in February 2026 (about 12% of the registry), and later scans reported over 800 (about 20%). Snyk found prompt injection in 36% of audited skills. Skills and MCP servers run with the agent's permissions.

## Decision

- MCP servers come from a reviewed catalog with pinned URLs, and authorization-server origins are validated.
- Skills are instructions only (steps, checks, approval points). Any code a skill needs runs in the sandbox.
- There is no open community marketplace. Users can add a custom MCP server behind an explicit warning.

## Alternatives considered

- **An open community marketplace:** the supply-chain path that compromised OpenClaw users.

## Consequences

- **Positive:** a much smaller supply-chain attack surface.
- **Negative:** the catalog grows more slowly.
- **Follow-up:** a review checklist for catalog additions; agent templates exported as files contain configuration only.
