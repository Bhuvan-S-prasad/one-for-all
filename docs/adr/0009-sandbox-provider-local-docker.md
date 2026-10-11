# ADR-0009: Sandbox behind SandboxProvider, local Docker first

- **Status:** Superseded by ADR-0025 (the image) and ADR-0026 (VNC); the `SandboxProvider` interface stands
- **Date:** 2026-09-30
- **Area:** Computer
- **Related:** ADR-0001, ADR-0010, ADR-0017, ARCHITECTURE.md §10.5, §14

## Context

Agents need a real computer: browser, shell, files, and a screen the user can watch and take over. E2B offers Firecracker microVMs with pause and resume (memory and disk kept indefinitely), but its free Hobby plan is a one-time $100 credit with a 1-hour continuous-runtime limit. The open-source AIO Sandbox image (agent-infra, Apache-2.0) bundles Chromium over CDP, VNC, shell, files, Jupyter and MCP in one container.

## Decision

Define `SandboxProvider` in `packages/core` (acquire, pause, exec, browser via CDP, VNC URL). Ship two adapters in `packages/sandbox`:

- **Docker (default):** a hardened AIO Sandbox image in the Compose bundle.
- **E2B:** for cloud mode, and for self-hosters who prefer it.

## Alternatives considered

- **E2B only:** the free credit runs out, after which users must pay.
- **Running agent code on the host:** OpenClaw's host mode turned prompt injection into full machine compromise.

## Consequences

- **Positive:** free and local by default; the choice stays open.
- **Negative:** users need Docker, and a container isolates less than a microVM. To compensate, the image runs non-root with no Docker socket, no host mounts except its own volume, CPU and memory limits, and an egress allowlist.
- **Follow-up:** `infra/docker/sandbox/` hardened image with multi-arch builds (x64 and arm64).
