# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

One-for-All: a self-hosted platform for teams of always-on AI agents (modelled on OpenAI Dots and xAI Grok Bot). Each agent has one job, a sandboxed computer, granted tools (MCP-first), memory, and routines. Users reach agents from a web app, an Expo mobile app, Telegram and Slack.

**Status:** pre-implementation. The architecture is agreed; no source code exists yet. Next milestone: **M1 Foundation**.

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

TypeScript everywhere · pnpm + Turborepo · Hono API · Vite + React SPA (TanStack Router/Query, Tailwind, shadcn/ui) · Expo (Expo Router, NativeWind) · Postgres 17 + pgvector · Drizzle · self-hosted Inngest · AI SDK + OpenRouter (user's key) + optional Ollama · MCP · local Docker sandbox (AIO) with E2B adapter · Better Auth · OpenTelemetry · zod.

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

## Constraints to design around

- OpenRouter free models: 20 requests/minute and 1,000/day per user. All model calls go through the shared queue in `packages/llm`. Prefer DOM/accessibility-tree browsing over screenshots.
- Free models have small context windows; respect the context budgets in ARCHITECTURE.md §7.
- The self-host bundle targets ~3 GB RAM and must run on arm64 (Oracle Always Free, Raspberry Pi) as well as x64.
- No channel may require a public URL (Telegram polling, Slack Socket Mode, Tailscale for mobile).

## Keeping docs current

- When a decision changes, update ARCHITECTURE.md and add or supersede an ADR in `docs/adr/` in the same change.
- When a milestone completes, update the **Status** line above, ARCHITECTURE.md §18 and the tracker's status table.

## Commands

None yet. M1 will add workspace scripts (`pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm eval`); document them here when they exist. Do not invent commands before then.
