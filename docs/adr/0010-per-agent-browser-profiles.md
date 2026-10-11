# ADR-0010: One computer per user, one browser profile per agent

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Computer
- **Related:** ADR-0009, ADR-0013, ARCHITECTURE.md §10.5

## Context

Agents hand work to each other through shared files, so they benefit from one shared machine. Grok Bot shares one computer per user, including all browser logins, and its docs repeatedly warn that Bots are not a security boundary: signing in for one Bot signs in every Bot. That undermines per-agent grants for anything done in the browser. One container per agent would cost too much RAM on home machines.

## Decision

Each user gets one sandbox. All their agents share `/workspace` for handoffs, but each agent gets its own Chromium profile (cookies, sessions, saved logins). Sharing a login with another agent is an explicit opt-in.

## Alternatives considered

- **Fully shared browser state:** any agent can act through any login.
- **One sandbox per agent:** strongest isolation, but RAM grows with every agent.

## Consequences

- **Positive:** grants mean something in the browser too; a compromised agent cannot use another agent's sessions.
- **Negative:** a user may sign in twice for two agents; files in `/workspace` remain shared.
- **Follow-up:** profile management in `packages/sandbox`; an opt-in "share this login with" control in the UI.
