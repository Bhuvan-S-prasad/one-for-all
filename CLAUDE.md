# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

One-for-All: a self-hosted platform for teams of always-on AI agents (modelled on OpenAI Dots and xAI Grok Bot). Each agent has one job, a sandboxed computer, granted tools (MCP-first), memory, and routines. Users reach agents from a web app, an Expo mobile app, Telegram and Slack.

**Status:** **M1 Foundation** is done: monorepo and tooling, Postgres schema with RLS, Hono API with auth and first-run setup, the web app (setup, login, app shell), the Docker image, the self-host bundle and CI. **M2 First agent** is done: the agent harness, the replaceable model gateway, durable Inngest runs, built-in web and memory tools with schema-checked calls, live web chat with Activity and Settings, familiars and voice, learning after the run, and the `evals/` scaffold. The **UX Experience pass** is done: shell and palette, chat with a live loader, Markdown with sources and charts, Activity, Home, Agents, chats and history, memory review, toasts with Undo, and a phone pass (design canvas linked in the tracker). **M3 The computer** is done: our own sandbox image with one Linux user per agent and an egress proxy, `packages/sandbox`, browser, shell and files tools, artifacts, watching and takeover over CDP, saved logins, the computer panel, approve-or-deny cards (brought forward from M4) and address provenance in tainted runs (ADR-0027), checked end to end and in the self-host bundle. **M4 Integrations & policy** is done: `packages/mcp` (MCP client with OAuth kept in the database, a reviewed catalog of seven apps, app tools compiled from their schemas, `load_toolkit`), Gmail on Google's own API (ADR-0031), the full vault (keyring, rotation, OS keychain), the full policy engine with rules and site answers (ADR-0028), background token refresh, draft cards you can edit before approving (ADR-0030), per-agent app grants, notifications, redaction checked end to end, and a red-team mailbox set; checked end to end with Notion and Gmail and in the self-host bundle. **M5 The team** is done: delegation with fork-join (ADR-0032), agent messages and group threads with a coordinator (ADR-0033), interrupts that steer, stop and preempt (ADR-0034), routines on a cron tick and tasks and reminders that sleep until due (ADR-0035), read-only proactive checks that speak only when needed (ADR-0038), skills applied by `/name` (ADR-0036), episodes, scoped facts and nightly memory consolidation (ADR-0037), agents as JSON files and unread chats (ADR-0039), the team screens (group chat, routines, skills, memory) and multi-agent evals; checked live on the dev stack. **M6 Everywhere** is next.

**Source of truth:** [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md). Read the relevant section before designing or changing anything. If a change contradicts it, stop and raise it with the user rather than diverging silently.

## Git: hands off

**Never run any git command in this project** (`init`, `add`, `commit`, `push`, `branch`, `checkout`, `stash`, `status`, `diff`, `log`, or anything else), and never create commits or pull requests. The user handles all version control. If a task seems to need git, say so and leave it to the user.

## Session workflow

Progress is tracked in [docs/planning/TRACKER.md](docs/planning/TRACKER.md).

1. **Start of session:** read the tracker's *Now* section and the latest session-log entry. Pick the first unchecked task in the current milestone whose dependencies are done.
2. **While working:** mark the task `[~]`, then `[x]` with a short `→` note when done. Put newly discovered work into the right milestone or the Backlog.
3. **End of session (or before context runs low):** update *Now*, the milestone status table, and add a session-log entry (done, next, open issues).

The tracker records work only. Decisions go in ADRs; design goes in ARCHITECTURE.md.

## Stack

TypeScript everywhere · pnpm + Turborepo · Hono API · Vite + React SPA (TanStack Router/Query, Tailwind, shadcn/ui) · Expo (Expo Router, NativeWind) · Postgres 17 + pgvector · Drizzle · self-hosted Inngest · AI SDK + OpenRouter (user's key) + optional Ollama · MCP · local Docker sandbox (own slim image, ADR-0025) with E2B adapter · Better Auth · OpenTelemetry · zod.

Do not introduce Next.js, Express, Prisma, Neon, BullMQ or Redis-only designs; each was considered and rejected (ARCHITECTURE.md §16).

## Hard rules

These are architectural invariants. Code that breaks one is a bug, even if it works.

1. **Layering.** A layer only calls layers below it (ARCHITECTURE.md §3). The API never runs the agent loop; the harness never talks to channels, the database or the sandbox directly, only through `packages/core` interfaces.
2. **Composition roots.** Adapters are chosen only in `apps/*/src/container.ts`. No `if (mode === "cloud")` anywhere else.
3. **Tenancy.** Every table has `workspace_id`; every repository function takes a `TenantContext`. No query without one. RLS stays on in self-host mode.
4. **Credentials.** Tokens and secrets are decrypted only inside the tool executor. Never put them in prompts, logs, traces, tool results, the sandbox or test fixtures. Redact known secret values from all output.
5. **Policy in code.** Every tool call goes through `PolicyEngine`; the strictest verdict wins. Taint escalation applies to outbound tools in runs that read untrusted content. Never implement a permission as a prompt instruction only.
6. **Durability.** Side effects happen inside Inngest `step.run`. Code outside steps re-runs on replay. Every tool call carries an idempotency key (`runId:step`).
7. **Run log.** Every model call, tool call, verdict and approval is appended as a `run_event`. Never mutate past events.
8. **Perimeter.** The app binds to `127.0.0.1`, requires login, and checks Origin/CSRF on HTTP and WebSocket. Agent code runs only in the sandbox, never on the host.

## Repository layout

Follow ARCHITECTURE.md §17 exactly. Key points:

- `apps/` holds deployables (`api`, `worker`, `web`, `mobile`); `packages/` holds libraries; `tooling/`, `infra/`, `evals/`, `docs/` each have one job.
- The root holds workspace config only. A new top-level folder needs an ADR in `docs/adr/`.
- Web and mobile may import only `core`, `contracts` and `client`.
- Each package exposes one `index.ts` via `exports`; no deep imports.
- Unit tests sit beside code as `*.test.ts`; agent behavior is tested in `evals/`.
- `graft/` is a local code-index cache, not project code. Keep it git-ignored. Once code exists, use the graft tools for navigation before grepping.

## Conventions

- zod schemas in `packages/contracts` are the single source of truth for API and event shapes; derive types from them.
- Name Inngest events `domain/noun.verb` (e.g. `agent/message.received`, `approval/decided`).
- Name tools `app.action` in snake_case after the dot (e.g. `gmail.create_draft`, `web.search`).
- Prompt templates are versioned; bump the version when wording changes.
- Match the existing code's style and comment density once code exists.

## Design

The UI follows the design canvas "One-for-All M1 Screens" (https://claude.ai/artifact/93PUj8QtRHL3VP8jX9v1Du). Read the relevant artboard before building a screen.

- Dark by default, light as an option. Tokens live in `tooling/tailwind/theme.css`; use them, not raw hex.
- Bricolage Grotesque for headings, Geist for text, Geist Mono for labels (the `eyebrow` utility). Fonts are bundled, never loaded from a CDN.
- Acid lime (`primary`) is for actions and "needs you". Status is never shown by colour alone.
- Every agent has a **familiar** (its avatar): look schema in `@ofa/contracts`, geometry in `@ofa/client`, rendered by `apps/web/src/components/familiar.tsx`.
- Wording: "hatch" and "familiar" are user-facing; navigation, errors, approvals and permissions use plain words. In code and docs, "agent" is the domain term and "familiar" means only the avatar.

## Constraints to design around

- OpenRouter free models: 20 requests/minute and 1,000/day per user. All model calls go through `LLMGateway` and its shared queue in `packages/llm`. Prefer DOM/accessibility-tree browsing over screenshots.
- Model providers are replaceable (ADR-0022): provider-specific code lives only in `packages/llm/src/providers/<name>.ts`, chosen in `container.ts` by `LLM_PROVIDER`. Never import a provider SDK anywhere else, and never name a model outside tier config.
- Free models have small context windows; respect the context budgets in ARCHITECTURE.md §7.
- The self-host bundle targets ~3 GB RAM and must run on arm64 (Oracle Always Free, Raspberry Pi) as well as x64.
- No channel may require a public URL (Telegram polling, Slack Socket Mode, Tailscale for mobile).

## Keeping docs current

- When a decision changes, update ARCHITECTURE.md and add or supersede an ADR in `docs/adr/` in the same change.
- When a milestone completes, update the **Status** line above, ARCHITECTURE.md §18 and the tracker's status table.

## Commands

Run from the repo root unless noted. Node 24, pnpm 12.3.4, Docker.

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies (respects the release-age wait and `allowBuilds`) |
| `pnpm infra:up` / `infra:down` / `infra:reset` | Start, stop, or stop and delete the dev Postgres, Inngest, SearXNG and the agents' sandbox with its egress proxy (127.0.0.1 only; the first start builds the sandbox image) |
| `pnpm dev` | API on :3000 and web app on http://localhost:5173 (Vite proxies `/api`) |
| `pnpm build` | Bundle the API (`apps/api/dist/server.js`) and build the web app |
| `pnpm lint` | ESLint, including the import-boundary rules |
| `pnpm typecheck` | TypeScript in every package |
| `pnpm test` | Unit tests; no Docker needed |
| `pnpm test:integration` | Integration tests in throwaway databases; needs `pnpm infra:up` |
| `pnpm format` / `pnpm format:check` | Prettier |
| `pnpm --filter @ofa/db db:generate` | Create a migration from schema changes (then add RLS for new tenant tables by hand) |
| `pnpm --filter @ofa/db db:migrate` | Apply migrations to the dev database |
| `pnpm --filter @ofa/api db:seed` | Dev owner, workspace and sample agents (development only) |
| `pnpm eval` | Eval cases (golden and red-team) against live models on fixtures; `--list`, `--case`, `--k`, `--model` (needs `LLM_API_KEY`; uses real quota) |
| `pnpm vault status` / `keychain:store` / `keychain:rotate` | Which vault key wraps how many values; copy `VAULT_KEY` into the OS keychain; rotate a key kept there (the app finishes the rotation at its next start). Prints fingerprints, never keys |
| `pnpm --filter @ofa/llm spike` | Tool-calling check of free models for the tiers (needs `LLM_API_KEY` in `.env`; uses real quota) |
| `sh infra/scripts/init-env.sh` | Create `infra/compose/.env` with random secrets for the self-host bundle |
| `docker compose -f infra/compose/docker-compose.selfhost.yml up -d --build` | Build and run the self-host bundle on http://localhost:3000 |

After adding or renaming an Inngest function, re-register with the dev server: `curl -X PUT -H "Host: host.docker.internal:3000" http://127.0.0.1:3000/api/inngest` (a plain `localhost` registration points the Inngest container at itself). `apps/web/src/routeTree.gen.ts` is generated by the router plugin and must be committed (typecheck needs it).
