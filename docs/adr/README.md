# Architecture Decision Records

Each file records one significant decision: the context, what we chose, what we rejected, and what it costs. [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) describes how the system works now; these records explain how it got that way.

## Rules

- One decision per file, numbered in order: `NNNN-short-slug.md`.
- Never rewrite an accepted decision. To change it, add a new ADR and set the old one's status to `Superseded by ADR-NNNN`.
- Write one when a decision is expensive to reverse or likely to be questioned later.
- Update ARCHITECTURE.md in the same change.
- Start from [0000-template.md](0000-template.md).

## Status values

`Proposed` · `Accepted` · `Superseded by ADR-NNNN` · `Deprecated`

## Index

| ADR | Title | Area | Status |
|---|---|---|---|
| [0001](0001-self-hosted-first.md) | Self-hosted first, multi-tenant-ready data | Platform | Accepted |
| [0002](0002-thin-clients-hono-vite-expo.md) | Thin clients over one API: Hono, Vite SPA, Expo | Clients | Accepted |
| [0003](0003-monorepo-pnpm-turborepo.md) | Monorepo with pnpm and Turborepo | Platform | Accepted |
| [0004](0004-postgres-pgvector-bundled.md) | Postgres with pgvector, bundled | Platform | Accepted |
| [0005](0005-drizzle-orm.md) | Drizzle as the ORM | Platform | Accepted |
| [0006](0006-inngest-durable-execution.md) | Durable execution with self-hosted Inngest | Runtime | Accepted |
| [0007](0007-event-bus-interface.md) | Event bus behind an interface | Runtime | Accepted |
| [0008](0008-model-gateway-ai-sdk-openrouter.md) | Model gateway on the AI SDK and OpenRouter | Runtime | Accepted |
| [0009](0009-sandbox-provider-local-docker.md) | Sandbox behind SandboxProvider, local Docker first | Computer | Superseded by ADR-0025 (image) |
| [0010](0010-per-agent-browser-profiles.md) | One computer per user, one browser profile per agent | Computer | Accepted |
| [0011](0011-mcp-first-integrations.md) | MCP-first integrations | Integrations | Accepted |
| [0012](0012-credentials-never-reach-model.md) | Credentials never reach the model or the sandbox | Security | Accepted |
| [0013](0013-policy-engine-taint-escalation.md) | Policy engine: strictest verdict wins, taint escalation | Security | Accepted |
| [0014](0014-run-as-unit-of-truth.md) | The run is the unit of truth | Runtime | Accepted |
| [0015](0015-idempotent-side-effects.md) | Side effects happen exactly once | Runtime | Accepted |
| [0016](0016-channels-without-public-url.md) | Channels that need no public URL | Clients | Accepted |
| [0017](0017-local-first-perimeter.md) | Local-first security perimeter | Security | Accepted |
| [0018](0018-curated-catalog-no-marketplace.md) | Curated catalog, no open skill marketplace | Security | Accepted |
| [0019](0019-observability-opentelemetry.md) | Observability through OpenTelemetry, kept local | Runtime | Accepted |
| [0020](0020-identity-tables-outside-tenant-rls.md) | Identity tables sit outside tenant row-level security | Security | Accepted |
| [0021](0021-api-client-from-contracts.md) | The API client is built from contracts, not Hono RPC types | Clients | Accepted |
| [0022](0022-replaceable-model-providers.md) | Model providers are replaceable, one file each | Runtime | Accepted |
| [0023](0023-familiars-and-voice.md) | Every agent has a familiar and a voice | Clients | Accepted |
| [0024](0024-learning-after-the-run.md) | Agents learn after the run, not during it | Runtime | Accepted |
| [0025](0025-own-slim-sandbox-image.md) | Our own slim sandbox image, one Linux user per agent | Computer | Accepted |
| [0026](0026-watch-and-takeover-over-cdp.md) | Watch and take over the browser over CDP, not VNC | Computer | Superseded by ADR-0040 |
| [0027](0027-address-provenance-in-tainted-runs.md) | In a tainted run, open only addresses the run was given | Security | Accepted |
| [0028](0028-site-answers-and-the-always-human-list.md) | Approve a site for one task; the always-human list is classified by name | Security | Accepted |
| [0029](0029-tools-beside-an-mcp-server.md) | A few hand-written tools beside an MCP server, on its sign-in | Integrations | Accepted |
| [0030](0030-edit-before-approving.md) | A person can change a held call's written text before approving | Security | Accepted |
| [0031](0031-gmail-through-googles-api.md) | Gmail through Google's own API, with a direct Google sign-in | Integrations | Accepted |
| [0032](0032-delegation-one-level-from-a-brief.md) | Delegation goes one level deep, from a brief, with taint carried both ways | Runtime | Accepted |
| [0033](0033-group-threads-and-agent-messages.md) | Group threads give each message one responder; agents message each other one hop | Runtime | Accepted |
| [0034](0034-interrupts-steer-stop-preempt.md) | A person's message steers the run in its chat, "stop" halts it, and routines yield | Runtime | Accepted |
| [0035](0035-routines-and-prospective-memory.md) | Routines fire from a minute tick; tasks and reminders sleep until due | Runtime | Accepted |
| [0036](0036-skills-are-reviewed-instructions.md) | Skills are reviewed instructions, applied by `/name` or `run_skill` | Runtime | Accepted |
| [0037](0037-episodes-scopes-and-nightly-consolidation.md) | Episodes for every run, facts filed by whose they are, and a nightly pass that only expires | Runtime | Accepted |
| [0038](0038-proactive-checks-read-only-and-quiet.md) | Proactive checks are read-only routines that never wait and speak only when needed | Security | Accepted |
| [0039](0039-agent-files-and-unread.md) | Agents travel as JSON files and arrive held for review; unread is per person and per chat | Product | Accepted |
| [0040](0040-light-desktop-watched-over-vnc.md) | A light desktop per agent, watched over VNC | Computer | Accepted |
| [0041](0041-desktop-apps-accessibility-tree-first.md) | Desktop apps through the accessibility tree first, screenshots as a fallback | Computer | Accepted; opening superseded by ADR-0043 |
| [0042](0042-python-packages-and-office-files.md) | Python packages in each agent's venv; any file can go back to the person | Computer | Accepted |
| [0043](0043-opening-a-file-on-the-desktop-is-not-outbound.md) | Opening a file on the desktop is not outbound | Security | Accepted |
