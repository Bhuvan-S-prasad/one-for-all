# Handoff

Where One-for-All stands on 2026-10-11, and how to pick it up on another machine or in a new Claude Code session. [TRACKER.md](TRACKER.md) holds the task-level record; this page is the short version plus the setup steps.

## Where things stand

| Milestone | State |
|---|---|
| M0–M5, UX pass | ✅ Done |
| Desktop (DT.01–DT.14) | ✅ Done this session: the light desktop over VNC, the agent's terminal on it, desktop apps through the accessibility tree with a screenshot fallback, Python with Word and Excel files, `files.send` and the Files section, desktop evals on a real computer; checked live on the dev stack and in the self-host bundle; arm64 images build |
| **M6 Everywhere** | **Next.** First task: **M6.01 device pairing** (QR with a one-time code, device sessions, revoke in Settings) |
| M7 Hardening | Not started |

For one person on the web, the planned product is complete. What remains is other ways to reach agents (phone, Telegram, Slack), and hardening (CI evals, backups, installer).

**Checks at handoff:** unit tests 421 and integration tests 150 (API 77, DB 36, sandbox 20, vault 9, memory 5, events 3) pass. Typecheck, lint (no errors) and format are clean. Live desktop evals: report 6/6, laptop sheet 7/8, editing in a desktop app 5/5, red team 5/5.

## Before you switch machines

1. **Commit and push.** All of this session's work is uncommitted on the branch `desktop` (Claude never runs git here). Before you switch, commit and push it, then merge to `main` when you're ready.
2. **Move your secrets yourself.** `.env` at the root and `infra/compose/.env` are git-ignored, so they don't travel with the repo. Copy them over a private channel, or make new ones (step 3 below).
3. **Data stays behind.** Anything that lives in Docker volumes on this laptop stays here unless you move it:
   - the dev database: agents, chats, memory, app connections;
   - the agents' files and homes;
   - your own self-host bundle's data.

   There is no backup script yet (M7.03). Starting fresh on the new laptop is fine for development.

## Setting up the new laptop

Needs Node 24, pnpm 12.3.4, Docker Desktop (give it at least 4 GB of memory) and Git.

1. Clone the repo and check out `desktop` (or `main` after merging).
2. Run `pnpm install`. It respects pnpm's release-age wait and `allowBuilds`; don't bypass them.
3. Create `.env` from `.env.example`, or copy your old one:
   - `AUTH_SECRET`: any random 32+ characters.
   - `VAULT_KEY`: 32 random bytes in base64. A new key is fine for a fresh database. If your old `.env` says `VAULT_KEY_SOURCE=keychain`, the old key is in the old laptop's keychain; you only need it to read the old database.
   - `LLM_API_KEY`: your OpenRouter key. You can also save it per workspace in Settings.
4. Run `pnpm infra:up`. The first start builds the sandbox image, which takes about 10 minutes.
5. Run `pnpm --filter @ofa/db db:migrate`, then `pnpm --filter @ofa/api db:seed` (dev owner `owner@example.com` / `dev-password-123`).
6. Run `pnpm dev`, then register the Inngest functions:
   `curl -X PUT -H "Host: host.docker.internal:3000" http://127.0.0.1:3000/api/inngest`
7. Sign in at http://localhost:5173. To test the integrations again, reconnect Notion and Gmail; see [google-oauth-client.md](../guides/google-oauth-client.md).
8. Verify with `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:integration`. Optionally run `pnpm eval --case desk`, which uses real quota.

For the self-host bundle, `sh infra/scripts/init-env.sh` writes a new `infra/compose/.env`.

`graft/` is a local code index and git-ignored; rebuild it on the new laptop if you use graft.

## Local addresses

| Address | What |
|---|---|
| http://localhost:5173 | Web app (Vite; proxies `/api`) |
| http://127.0.0.1:3000 | API (`node --watch`: restarts on edits, brief 502s are normal) |
| 127.0.0.1:5432 | Postgres |
| http://127.0.0.1:8288 | Inngest dev server |
| http://127.0.0.1:8888 | SearXNG |
| http://127.0.0.1:7070 | The agents' sandbox service (dev token `ofa-sandbox-dev-token`) |

## Rules for a new Claude Code session

Start the session with: *"Read CLAUDE.md, docs/planning/HANDOFF.md, and the tracker's Now section and latest session log, then continue with M6.01."*

These rules held for the whole project (most are in [CLAUDE.md](../../CLAUDE.md)):

- **No git at all.** Claude runs no git command and makes no commits or pull requests; you handle version control.
- **Secrets:** never read or print the root `.env` or `infra/compose/.env`. Scripts may load them themselves and must never print keys. Credentials are decrypted only in the tool executor.
- **Tooling:** use workspace tools through `pnpm exec`, never `npx`, and don't bypass pnpm's supply-chain protections.
- **Models:** provider SDKs only in `packages/llm/src/providers/<name>.ts`; never name a model outside tier config.
- **Architecture:** if a change contradicts ARCHITECTURE.md, stop and ask. Decisions go in ADRs.
- **Dev servers:** you run `pnpm dev` yourself.
- **Tracker:** mark tasks `[~]` then `[x]` with a `→` note; end each session with *Now*, the status table and a session-log entry.

## Decisions waiting for you

- **Default token budget per agent.** 120k ran out on the desktop done-when task (research plus a Word and an Excel file); 300k was enough. Raise the default, or leave it to Settings? It's in the tracker's Backlog.
- **License.** Needed before the first public push ([ARCHITECTURE.md §19](../architecture/ARCHITECTURE.md#19-open-questions)).

## Known quirks

- **Never run `docker compose` for the dev stack without `--env-file infra/compose/dev.env`.** The compose file sits next to `infra/compose/.env`, so a bare `docker compose -f infra/compose/docker-compose.dev.yml …` picks up the bundle's secrets, and the sandbox then rejects the app's token. Use `pnpm infra:up`, or pass the env file.
- After Docker restarts, sometimes only the sandbox comes back. Run `pnpm infra:up`.
- **Free models:** OpenRouter's free models allow 20 requests a minute and 1,000 a day, and are sometimes flaky. They cut off long tool calls, return empty answers and leak reasoning. The gateway now falls back to the next model in each of these cases. Live evals and spikes use real quota.
- **The sandbox:**
  - at most three desktops are open at once; an idle desktop closes after 10 minutes;
  - when a desktop closes for idleness, the agent's terminal session (`tmux`) keeps running, at most 8 tabs;
  - three desktops use 0.9–1.2 GB of its 1.5 GB cap, so heavy pages leave little room.
- **Desktop evals** run on the dev sandbox as agent `eval-desk`. They clean up what they add to `/workspace`, and are skipped when the sandbox is down.
- **Small known bug:** failed runs show "0 model calls"; it's in the Backlog.

## Where to look

| For | Read |
|---|---|
| Design and invariants | [ARCHITECTURE.md](../architecture/ARCHITECTURE.md), with the desktop in §10.5 and the vision spike in §19 |
| Why things are the way they are | [docs/adr/](../adr/README.md), with the desktop decisions in 0040–0043 |
| Every task and session | [TRACKER.md](TRACKER.md) (session 24 is this one) |
| The agents' computer | `infra/docker/sandbox/` (`server.mjs`, `desktop/one-for-all-a11y`, `Dockerfile`), `packages/sandbox/` |
| Agent tools | `packages/tools/src/builtins/` (`computer.ts`, `desktop.ts`) |
| Model gateway and fallbacks | `packages/llm/src/gateway.ts`, with tier and vision chains in `providers/openrouter.ts` |
| Evals | `evals/` (README; desktop cases in `suites/desk.ts`, the real-computer harness in `graders/computer.ts`) |

The live end-to-end scripts from this session (run the done-when through the API, measure RAM, start a throwaway bundle) were scratch files in a temp folder, not part of the repo. Their results are in the tracker. Adding a permanent browser end-to-end suite is task M7.12.
