# ADR-0025: Our own slim sandbox image, one Linux user per agent

- **Status:** Accepted
- **Date:** 2026-10-04
- **Area:** Computer
- **Related:** Supersedes the image choice in ADR-0009 (the `SandboxProvider` interface stands); amended by ADR-0040 (a light desktop on each agent's display) and ADR-0042 (pip, venv and office libraries); ADR-0010, ADR-0012, ADR-0013, ADR-0017, ARCHITECTURE.md §4, §10.5, §14.1

## Context

ADR-0009 chose the open-source AIO Sandbox image (agent-infra) for the local Docker sandbox. Checked before building M3.01, its multi-arch image is a 3.6 GB compressed download in 77 layers. It also bundles Jupyter, a VS Code server and an MCP hub that an agent's computer does not need. The self-host bundle targets about 3 GB of RAM on a Raspberry Pi or a free Oracle ARM VM, and "hardened" means little when much of the image is unused services.

ADR-0010 wants each agent's browser logins kept from the others. If every agent's processes run as the same Unix user in one container, an agent with a shell can read another agent's cookie database, so per-agent profiles alone do not isolate.

## Decision

Build our own image, `infra/docker/sandbox/`: Debian slim with Debian's Chromium (built for x64 and arm64), Xvfb, bash, Python 3, git and curl. A small dependency-free Node service (`server.mjs`) inside it does what the app asks, as the agent that asked.

- **One Linux user per agent.** Each agent gets its own uid (10001 and up), a private home (mode 700) and its own Chromium profile and display. All agents share the `agents` group, which owns `/workspace` (setgid). Processes start through `setpriv` with no new privileges.
- **Minimal root.** Only the service runs as root, and Compose leaves it just CHOWN, SETUID, SETGID and KILL. Agent code never runs as root. The root file system is read-only, with no Docker socket and no host mounts. CPU, memory and threads are limited.
- **One exit.** The sandbox sits on an internal Docker network with no route out. Its only exit is an egress proxy (`egress.mjs`, same image, unprivileged) with a domain allowlist (`SANDBOX_EGRESS_ALLOW`, `*` for any public site). The proxy refuses private, loopback, link-local and CGNAT addresses whatever the list says. The app reaches the service through a TCP forward on the egress container, so it never joins the sandbox network.
- **Browsers on demand.** Each agent's Chromium starts when first needed and closes after 10 idle minutes. At most three run at once; the least recently used closes first. Its profile, and so its logins, stays.
- **The browser is read through the accessibility tree**, not screenshots: each actionable element carries its backend DOM node ID, which `click` and `type` take. Nothing is kept between tool calls.

## Alternatives considered

- **AIO Sandbox, hardened in Compose:** 3.6 GB compressed with many unused services, and its single user would leave agents able to read each other's browser profiles.
- **One container per agent:** strongest isolation, but RAM grows with every agent (rejected in ADR-0010 for the same reason).
- **Network policy inside the sandbox (iptables):** needs NET_ADMIN, and a rule the sandbox holds is one an escape can change. An exit outside the sandbox cannot be changed from inside it.

## Consequences

- **Positive:** the image is about 1.1 GB uncompressed, and an idle browser costs about 100 MB. Agents cannot read each other's homes or logins. The sandbox cannot reach the database, the app, the home network or cloud metadata. Everything is plain Debian packages, so arm64 builds natively.
- **Negative:** we maintain the image and its service. Chromium runs with `--no-sandbox`, so the container (non-root users, dropped capabilities, no new privileges) is the boundary; a kernel escape is not contained. One computer serves the whole install, which suits single-owner self-host; a computer per person is the E2B adapter's job.
- **Follow-up:** VNC watch and takeover (M3.07) on each agent's display; a control in the UI for sharing a login between agents (ADR-0010; the mechanism exists as `shareLogin`); approval cards (M4.09), without which clicking, typing and the shell are held after a run reads outside content (ADR-0013).
