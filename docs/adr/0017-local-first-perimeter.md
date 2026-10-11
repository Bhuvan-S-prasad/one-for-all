# ADR-0017: Local-first security perimeter

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Security
- **Related:** ADR-0001, ADR-0016, ARCHITECTURE.md §10.5

## Context

In 2026 researchers found 42,665 publicly accessible OpenClaw instances, many over plain HTTP. CVE-2026-25253 (CVSS 8.8) was a one-click remote code execution chain that worked even against instances bound to localhost. A self-hosted agent holds the keys to a user's accounts, so its web UI is a high-value target.

## Decision

- The app binds to `127.0.0.1` by default.
- Login is required even on localhost.
- Every HTTP and WebSocket request is checked for Origin, and state-changing requests carry CSRF tokens.
- Remote and mobile access go through Tailscale.
- Devices pair with revocable sessions listed in Settings.

## Alternatives considered

- **Open ports with a password page:** the pattern that exposed OpenClaw users.

## Consequences

- **Positive:** closes the drive-by and cross-site attack paths seen in OpenClaw.
- **Negative:** remote access requires Tailscale or a tunnel.
- **Follow-up:** security middleware in `apps/api/src/middleware`; tests for Origin and CSRF enforcement, including WebSocket upgrades.
