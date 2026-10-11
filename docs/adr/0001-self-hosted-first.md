# ADR-0001: Self-hosted first, multi-tenant-ready data

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Platform
- **Related:** ADR-0004, ADR-0009, ADR-0017, ARCHITECTURE.md §2, §14

## Context

The project must be free to build and run. Hosting a persistent VM per account (the Dots and Grok Bot model) costs money for every user and concentrates everyone's OAuth tokens and data in one place. OpenClaw showed that users will self-host an always-on personal agent. A hosted version may still be wanted later, and retrofitting multi-tenancy onto a single-user schema is a rewrite.

## Decision

Ship One-for-All as a Docker Compose bundle that users run on their own machine or VM. Users bring their own OpenRouter key. Design the data model and runtime as multi-tenant from the start:

- Every table carries `workspace_id`; a self-hosted install is one workspace.
- Every call carries a `TenantContext` (`workspaceId`, `userId`, optional `agentId`, `runId`).
- Row-level security is enabled in self-host mode too, so there is one code path.
- Everything that differs between self-hosted and cloud sits behind a `packages/core` interface.

## Alternatives considered

- **Hosted only:** ongoing infrastructure cost per user, and we would hold every user's credentials.
- **Self-hosted only, single-user schema:** simplest now, but a hosted version later means rewriting the data layer.

## Consequences

- **Positive:** zero infrastructure cost for us; user data stays with the user; model rate limits are per user; a hosted version becomes an addition.
- **Negative:** agents are only always-on while the user's machine is on. Install, upgrade and backup must be easy, and we support a range of hardware (x64 and arm64).
- **Follow-up:** install and upgrade scripts, backup script, hosting guidance (spare machine, Raspberry Pi 5, Oracle Always Free VM).
