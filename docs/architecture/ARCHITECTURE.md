# One-for-All Architecture

> **Status:** Draft 0.1 · 30 Sep 2026 · pre-implementation (next milestone: M1)
> **Audience:** contributors and anyone deciding how a change fits the system.
> **Decisions:** summarized in [§16](#16-decision-log). Full records are in [`docs/adr/`](../adr/README.md).

One-for-All is a self-hosted platform for teams of always-on AI agents. Each agent has one job, a computer to work on, the tools you granted it, and memory that improves with use. You talk to agents from the web, your phone, Telegram or Slack, and they come back when something needs your approval.

It is modelled on the "AI teammate" products that appeared in 2026 (OpenAI Dots, xAI Grok Bot), with two differences: it runs on the user's own machine, and it is built to be free to operate (the user brings their own OpenRouter key).

---

## Contents

1. [Goals and non-goals](#1-goals-and-non-goals)
2. [Design principles](#2-design-principles)
3. [System layers](#3-system-layers)
4. [Core interfaces](#4-core-interfaces)
5. [How a task runs](#5-how-a-task-runs)
6. [Agent harness](#6-agent-harness)
7. [Context engineering](#7-context-engineering)
8. [Memory](#8-memory)
9. [Tools and integrations](#9-tools-and-integrations)
10. [Security](#10-security)
11. [Reliability](#11-reliability)
12. [Observability and evals](#12-observability-and-evals)
13. [Clients and channels](#13-clients-and-channels)
14. [Deployment](#14-deployment)
15. [Data model](#15-data-model)
16. [Decision log](#16-decision-log)
17. [Repository layout](#17-repository-layout)
18. [Build order](#18-build-order)
19. [Open questions](#19-open-questions)
20. [References](#20-references)

---

## 1. Goals and non-goals

**Goals**

- Persistent, named agents that own a job, keep context over time and work while the user is away.
- A team model: agents delegate to each other, share threads and hand work off.
- A real computer per user (browser, shell, files) that the user can watch and take over.
- Integrations through MCP, so adding an app is configuration rather than code.
- Human approval for consequential actions, enforced in code.
- One-command self-hosted install that costs nothing to run beyond the user's model usage.
- A data model and interfaces that allow a hosted multi-tenant version later without a rewrite.

**Non-goals (for now)**

- Training or fine-tuning models.
- An open, community skill marketplace (see [ADR-018](#16-decision-log)).
- Voice chat and teach-by-demonstration (planned after M7).
- Running agent code directly on the host machine.

---

## 2. Design principles

| Principle | Meaning in practice |
|---|---|
| **Ports and adapters** | Anything that differs between self-hosted and cloud sits behind an interface in `packages/core`. Switching modes changes configuration, not code. |
| **Durable by default** | Every agent run is a chain of durable Inngest steps. State lives in Postgres, never in process memory, so a restart resumes work instead of losing it. |
| **Security in code** | Permissions are enforced where tools execute and where rows are read. Prompts describe the rules; they never enforce them. |
| **Tenant-ready from day one** | Every row carries `workspace_id` and every call carries a `TenantContext`. A self-hosted install is one workspace. |
| **The run is the record** | Each agent execution writes an append-only event log. The Activity view, traces, evals, audit and crash recovery all read from it. |

---

## 3. System layers

Nine layers, each with one responsibility. A layer only calls the layers below it.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ L1  CHANNELS & CLIENTS   Web SPA · Expo app · Telegram · Slack · email   │  EDGE
├─────────────────────────────────────────────────────────────────────────┤
│ L2  GATEWAY API          Hono: auth, tenancy, REST + WebSocket,          │  EDGE
│                          approvals, device pairing, OAuth callbacks      │
├─────────────────────────────────────────────────────────────────────────┤
│ L3  ORCHESTRATION        Inngest: run lifecycle, routines, approval      │  RUNTIME
│                          waits, delegation, concurrency, cancellation    │
├─────────────────────────────────────────────────────────────────────────┤
│ L4  AGENT HARNESS        loop · context assembly · middleware hooks ·    │  RUNTIME
│                          compaction · budgets · stop conditions          │
├────────────────┬────────────────┬────────────────┬──────────────────────┤
│ L5 CAPABILITIES│ L6 MODEL       │ L7 MEMORY      │ L8 COMPUTER          │  SERVICES
│ tools, MCP,    │ GATEWAY        │ stores, recall,│ sandbox, browser     │
│ policy engine  │ routing,limits │ consolidation  │ profiles, screen     │
├────────────────┴────────────────┴────────────────┴──────────────────────┤
│ L9  DATA & PLATFORM      Postgres + pgvector (RLS) · vault · event bus · │  PLATFORM
│                          OpenTelemetry · config                          │
└─────────────────────────────────────────────────────────────────────────┘
```

| Layer | Owns | Code | Must never |
|---|---|---|---|
| **L1 Channels & clients** | Normalizes inbound messages to `InboundMessage`; renders `OutboundMessage` as chat, draft cards and approval buttons. | `apps/web`, `apps/mobile`, `packages/channels` | Run agent logic or hold credentials. |
| **L2 Gateway API** | Auth, `TenantContext` resolution, REST and WebSocket, approvals API, device pairing, OAuth callbacks. Serves the web build in self-host mode. | `apps/api` | Run the agent loop. Long work is emitted as an event and the request returns immediately. |
| **L3 Orchestration** | Run lifecycle, routines on cron, approval waits (`waitForEvent`), delegation (`step.invoke`), per-agent concurrency, throttling to the model quota, cancellation on interrupt. | `packages/orchestrator`, `apps/worker` | Call models or tools directly; it always goes through the harness. |
| **L4 Agent harness** | Context assembly, model call, tool dispatch through hooks, compaction, budgets, stop conditions. | `packages/harness` | Know which channel, database or sandbox is in use. It depends only on `core` interfaces. |
| **L5 Capabilities** | Tool registry (built-ins, MCP tools, sandbox tools), policy engine, credential injection at execution time. | `packages/tools`, `packages/mcp`, `packages/policy` | Put a token or password into a prompt, log or tool result. |
| **L6 Model gateway** | Provider adapters (one file each; OpenRouter first), model tiers, shared rate-limit queue, fallback chain with per-model circuit breakers, token and cost metering; requests with images go only to models that read them (a vision chain, then the tier's own, DT.10). | `packages/llm` | Bypass the queue, pick a model outside the workspace's tier mapping, or let provider details leak upward. |
| **L7 Memory** | Semantic, episodic, procedural and prospective stores; recall; post-run extraction; nightly consolidation. | `packages/memory` | Accept writes that skip policy. |
| **L8 Computer** | A light desktop per agent (ADR-0040): shell, files in `/workspace`, Python with a venv per agent (ADR-0042), Chromium over CDP with one profile per agent, desktop apps through the accessibility tree (ADR-0041), the whole screen streamed over VNC for watching and takeover. | `packages/sandbox`, `infra/docker/sandbox` | Touch the host file system or Docker socket, or reach domains outside the egress allowlist. |
| **L9 Data & platform** | Postgres + pgvector with row-level security, credential vault, event bus, telemetry, validated config. | `packages/db`, `vault`, `events`, `telemetry`, `config` | Run a query without a `TenantContext`. |

---

## 4. Core interfaces

All defined in `packages/core`. Adapters are chosen only in a composition root (`apps/api/src/container.ts`, `apps/worker/src/container.ts`).

| Interface | Responsibility | Self-hosted adapter | Cloud adapter |
|---|---|---|---|
| `ChannelAdapter` | Receive and normalize inbound; send outbound | Web, Telegram (long polling), Slack (Socket Mode) | Same, plus webhooks |
| `LLMGateway` | Generate; route, fall back, meter. Providers plug in as `ModelProvider` files (ADR-0022) | OpenRouter (user's key); any other provider is one file | Same, platform key with per-tenant metering |
| `SandboxProvider` | Acquire, pause; per agent: exec, files, browser (CDP, read through the accessibility tree), desktop (accessibility tree, input, screenshots), desktop stream (VNC) and takeover | Local Docker (our slim image, ADR-0025) | E2B (pause/resume) |
| `ToolSource` | `listTools(ctx)`, `call(name, args, ctx)` | Built-in, MCP, sandbox sources | Same |
| `PolicyEngine` | `evaluate(action, ctx)` → allow / approve / human / deny | Same | Same, plus org policies |
| `CredentialVault` | Get, put, rotate, redact secrets | AES-256-GCM, key from OS keychain or env | KMS envelope encryption |
| `MemoryStore` | Write, recall, consolidate | Postgres + pgvector | Same |
| `EventBus` | Publish and subscribe | Postgres `LISTEN/NOTIFY` | Valkey pub/sub |
| `Telemetry` | Spans and metrics | OpenTelemetry → local Phoenix, or off | OpenTelemetry → Langfuse or Grafana |

`TenantContext` (`workspaceId`, `userId`, optional `agentId`, `runId`) is passed through every call and is required by every repository function.

---

## 5. How a task runs

**Scenario:** from your phone you message Scout, your sales agent: *"Find this week's five hottest deals in HubSpot, research each company, and email the champions a follow-up."*

| # | Layer | What happens |
|---|---|---|
| 1 | L1 | The Expo app sends the message over its WebSocket. From Telegram it would arrive through the long-polling listener as the same `InboundMessage`. |
| 2 | L2 | The API checks the device session, resolves `TenantContext`, stores the message and emits `agent/message.received`. It returns immediately. |
| 3 | L3 | Inngest starts `agent-run` for Scout with a per-agent concurrency key. If Scout is busy, the message preempts the turn or is injected as steering at the next step boundary. |
| 4 | L4 | The harness loads Scout's spec, grants and budgets, and assembles the prompt from typed blocks. |
| 5 | L6 | The gateway picks the model tier, waits for a slot in the shared queue and calls OpenRouter as a durable step. |
| 6 | L5 | Scout calls `hubspot.search_deals` (MCP, annotated read-only). Policy returns **auto**. The OAuth token is injected inside the executor. |
| 7 | L8 | Scout opens company websites in its own browser profile. That content is labelled untrusted, and the run becomes **tainted**. |
| 8 | L5 | Scout calls `gmail.send`. It is outbound and the run is tainted, so policy returns **approve** even though the grant allows sending. The run pauses on `step.waitForEvent("approval/decided")`. |
| 9 | L1 | A push notification opens a draft card with *Send*, *Edit* and *Discard*. You edit one line and send. |
| 10 | L5 | The call is recorded `in_flight` with idempotency key `runId:step`, executed, then marked `done`. |
| 11 | L7 | On run end, an episode summary is stored and facts are extracted. Because the run was tainted, new facts are saved as **unverified**. |
| 12 | L9 | Every step was a `run_event` and an OpenTelemetry span. The Activity view updated live through the event bus; the approval is in the audit log. |

---

## 6. Agent harness

The harness is everything around the model. It shapes agent quality as much as the model does, so it is a first-class package with its own tests and evals.

### 6.1 Agents are specs

An agent is a declarative spec stored in Postgres, editable in the UI and exportable as a file: JSON (`one-for-all/agent`) with its spec, grants, own skills and routines, never sign-ins, secrets, memory or chats; an imported agent's skills wait for approval and its routines stay paused ([ADR-0039](../adr/0039-agent-files-and-unread.md)). The sketch below shows the same fields.

```yaml
name: Scout
job: Sales outbound
description: |            # standing rules: always in context
  Own weekly pipeline research and follow-ups.
  Draft in my voice. Never contact a customer
  or change the CRM without approval.
model_tier: standard          # fast | standard | strong
autonomy: act-with-approval   # suggest | act-with-approval | autonomous
voice: brief                  # calm | cheerful | brief | formal
avatar: { form: bloom, eyes: googly, skin: dots, color: lilac, mark: spark }
grants:
  hubspot.*:          { read: auto, write: approve }
  gmail.create_draft: auto
  gmail.send:         approve
  web.search:         auto
memory_scopes: [agent, workspace]
browser_profile: scout
routines:
  - cron: "0 7 * * 1-5"
    skill: morning-pipeline-review
budgets: { steps: 40, tokens: 120000 }
```

The **description** holds rules that stay true across tasks. **Task instructions** belong in the conversation. Guideline: one clear job per agent; "General helper" agents build less reusable context.

**Familiar and voice** ([ADR-0023](../adr/0023-familiars-and-voice.md)). `avatar` is the agent's familiar: a creature built from five fixed parts (form, eyes, skin, colour, mark) in `@ofa/contracts`, drawn from shared geometry in `@ofa/client`. Its mood (idle, thinking, working, waiting, asleep, stuck) is derived from the agent's latest run, never stored, and always shown with a word. `voice` is one of four presets rendered as the versioned prompt fragment `agent.voice@1`; it changes how the agent writes, never what it may do.

### 6.2 The loop as durable middleware

```
Run(agent, task, ctx)                                   ← Inngest function
 ├─ onRunStart   load spec and grants, check budgets, open trace span
 └─ loop until a stop condition
     ├─ assemble   build prompt from budgeted blocks (§7)
     ├─ llm        step.run("llm") through the model gateway
     ├─ for each tool call (parallel when independent)
     │   ├─ preTool   policy verdict, taint check, rate limit, idempotency key
     │   ├─ approval  step.waitForEvent("approval.decided") when verdict = approve
     │   ├─ execute   step.run("tool"); credentials injected only here
     │   └─ postTool  log event, move large output to an artifact,
     │                redact secrets, mark taint for untrusted content
 ├─ onRunEnd     episode summary, eval sample, notify
 └─ onError      retry with backoff, then escalate to the user

Learn(run)                                              ← separate Inngest function
 └─ on agent/run.succeeded: extract facts from the exchange (§8)
```

Hooks are real middleware (onion pattern). Policy, logging, redaction and memory behave the same for every agent.

**Learning happens after the run** ([ADR-0024](../adr/0024-learning-after-the-run.md)). A run ends at the reply. If it answered, `agent-run` sends `agent/run.succeeded` and the `agent-learn` function extracts facts, one at a time per workspace. The agent is free for the next message as soon as it replies, however slow the fast-tier model is.

**Stop conditions:** final answer · needs a human · step budget · token or cost budget · loop detected (same tool with same arguments repeated) · user said stop. From 80% of the token or step budget the task block tells the agent to finish the current item and answer; a run stopped by its budget makes one last call without tools to answer with what it has, then says what is left; a loop stop lists what was done from its chat record ([ADR-0045](../adr/0045-a-chat-keeps-its-working-state.md)).

**The chat record** ([ADR-0045](../adr/0045-a-chat-keeps-its-working-state.md)): after each model step that changed it, the loop saves the agent's working record for its chat (`thread_state`: plan, a ledger of what was done, compaction notes, how the last run ended) in its own step, so a run that stops, fails or is cancelled keeps its progress, and the next run in that chat continues from it (§7).

**Inngest rule:** code outside `step.run` re-executes on replay. All side effects live inside steps.

### 6.3 Working as a team

| Mechanism | How it works |
|---|---|
| **Delegation** | `delegate_task(agent, brief)` starts a child run with `step.invoke` ([ADR-0032](../adr/0032-delegation-one-level-from-a-brief.md)). The child gets a fresh context (brief + relevant memory), never the parent's transcript, and returns a structured result (`agent`, `status`, `answer`). The brief and the child's reply live in a `handoff` thread, outside the person's chats. One level deep: a delegated run can't delegate. A child of a tainted run starts tainted, and a child that read outside content taints its parent. Stopping a run stops its children. A brief can carry earlier handoffs' answers by name (`include_results_from`), a child with missing inputs says so instead of recreating them, and the person sees each handoff as a card under the reply, with the child's files there too (TC.10). |
| **Fork-join** | Independent delegations run as concurrent steps; the parent resumes when all results are in. All handoffs from one model step start before any is awaited. |
| **Group threads** | Two to six agents share a thread with the person ([ADR-0033](../adr/0033-group-threads-and-agent-messages.md)). Each message gets one responder: the member `@mentioned` first, otherwise the thread's coordinator (`thread.coordinator_agent_id`), which answers or passes it on with `message_agent` or `delegate_task`. Handoffs are visible. Agents' messages are labelled with their names in each other's context. |
| **Async messages** | `message_agent` posts in the run's own thread and wakes the named agent with an event (`trigger: event`, the sending run as parent); the woken agent reads the message as its request and replies later in the same thread. In a group, only members can be messaged; in a direct chat, any other active agent. One hop: a run started by another agent can't message or delegate. Taint carries over as for handoffs. |
| **Interrupts** | A direct user message outranks background work ([ADR-0034](../adr/0034-interrupts-steer-stop-preempt.md)). In a chat where the agent is already working, the message joins that run at its next step boundary (steering; its own queued run ends as `steered`). A message that is only "stop" or "stop now" stops every run in the chat through Inngest `cancelOn` and starts none. The agent's routine runs in other chats are set aside (`preempted`), and a person's message starts ahead of queued background runs. Completed actions are not undone. |
| **The roster** | Every list of agents a run can hand work to or message is read live and shows each agent's capability card, built from its grants and connected apps (`web: search, read pages`; `gmail: create draft (asks first)`), so a new agent, tool or app changes routing with no prompt edits ([ADR-0044](../adr/0044-team-roster-from-grants-coordinators-delegate.md)). |
| **Coordinators** | An agent with `role: coordinator` (a chief of staff, or a group's leader in that group) owns an outcome and routes work to specialists. It gets the team in its system prompt with coordination rules (plan with an owner per item, independent handoffs together, outbound work last, check results), and its own tools that a teammate also has are hidden from it, so routing is enforced in code rather than asked for in a prompt (ADR-0044). Outside a group it leads it has no `message_agent`: it waits for results with `delegate_task`. |

---

## 7. Context engineering

Every prompt is assembled from typed blocks, each with a token budget derived from the model's real context window (read from OpenRouter model metadata). Blocks are ordered stable → volatile so providers with prompt caching can reuse the prefix.

**Example budget for a 32,000-token model:**

| Group | Block | Contents | Tokens | Rule |
|---|---|---|---:|---|
| Stable prefix | Platform rules | Safety rules, tool-use norms, output format | 1,200 | Identical bytes every call |
| Stable prefix | Agent identity | Job, standing description, voice, pinned preferences | 1,000 | Changes only when the agent is edited |
| Stable prefix | Tool schemas | Granted tools, stable order, at most ~20 | 4,000 | More load on demand via `load_toolkit`; may borrow up to its size again from history (one app schema can be ~2,000 tokens) |
| Per task | Task and plan | The latest request, the agent's todo list, and its notes from compacted steps | 800 | Restated each step, in the system block |
| Per task | Retrieved memory | Top facts, the two closest earlier episodes, and the steps of a skill named with `/slug` | 2,500 | Small preload; `recall()` and `run_skill` for the rest |
| Per task | Earlier in this chat | The agent's chat record: plan, what it already did (actions, handoffs and answers, searches, pages), notes, how the last run ended ([ADR-0045](../adr/0045-a-chat-keeps-its-working-state.md)) | 1,500 | Taken from history; oldest entries dropped first |
| Volatile | History | Structured summary + recent turns verbatim | 10,000 | Compacted at 70% of the window |
| Volatile | Untrusted content | Emails, pages, documents, tool output | 6,500 | Wrapped in `<untrusted source="…">`; sets taint |
| Reserve | Output | Reply and tool calls | 6,000 | Never spent on input |

**Techniques**

- **Artifacts over dumps.** Output longer than 12,000 characters is stored as an artifact (the `artifact` table; 10 MB at most); the context gets its start and a handle, `artifact://<id>`, which the agent reopens with `artifacts.read`, a platform tool every agent may use for its own artifacts. Files an agent writes are kept the same way and shown under its reply.
- **Structured compaction.** Older turns become sections: decisions made, facts learned, open items, artifacts produced. The result is the agent's private notes, placed in the task block, never a message in the conversation: a model once returned notes inserted as a user message as its answer. The notes count against the history budget.
- **Read in chunks.** `web.read_url` returns 6,000 characters at a time and says how to read on (`from`), so a few long pages do not fill a small window.
- **Scoped subagents.** Delegated work starts from a brief; parent transcripts never leak into a child's window.
- **Work carries across runs.** A run's tool results and plan end with it, but its chat record does not: the next run in the chat sees what was done and the open plan, so "continue" continues instead of starting over (ADR-0045). The same `web.search` twice in one run returns the earlier result.
- **Small tool lists.** Free models degrade with long tool lists, so grants filter tools and `load_toolkit(app, tools?)` adds more on demand: a small app whole, a large one a few named tools at a time.
- **Provenance labels.** Untrusted content is always wrapped and labelled. Labels do not stop injection on their own; they drive taint tracking (§10.3).
- **Versioned prompts.** Every template has a version, logged on each trace.

---

## 8. Memory

Four stores, one access mechanism, one scheduler, and the model itself.

| Type | Holds | Implementation | Written by |
|---|---|---|---|
| Working | The current prompt | Context assembler | Harness, every step |
| Chat record | Per chat and agent: plan, what was done, notes, how the last run ended | `thread_state` rows ([ADR-0045](../adr/0045-a-chat-keeps-its-working-state.md)) | Harness, after each step that changed it |
| Semantic | Facts and preferences | `memory` rows; Postgres full-text search in M2, pgvector added later | `remember` tool, post-run extraction |
| Episodic | What happened and how it ended | `run` + `episode` summary, one per run that replied ([ADR-0037](../adr/0037-episodes-scopes-and-nightly-consolidation.md)) | The run's end (`Asked: … — Answered: …`), replaced by the learning pass's summary |
| Procedural | How to do a task | `skill` rows: instructions only, active or proposed ([ADR-0036](../adr/0036-skills-are-reviewed-instructions.md)); `/slug` in a request or `run_skill` applies one | People, `save_skill` (proposed after outside content), consolidation proposals |
| Prospective | What to do later | `routine` rows fired by a minute tick; `schedule` rows, each sleeping until due (`sleepUntil`) ([ADR-0035](../adr/0035-routines-and-prospective-memory.md)) | Routines, `schedule_task`, `remind_me` |
| Retrieval | An access path, not a store | `recall()` over semantic, episodic and documents | n/a |
| Parametric | What the model already knows | Model weights | Outside our control |

**Scopes:** `workspace` (team knowledge) · `agent` (role context) · `agent×user` (private per-person notes, ready for team agents).

**Rules**

- Memory writes go through policy. Facts learned during a tainted run are stored with `verified = false` and are not preloaded until the user confirms them.
- **People review what was learned** (UX.14): the agent's Memory tab, Home and the reply that learned something list facts; unverified ones wait under "To confirm" with Keep and Forget. Confirming is audited (`memory.confirmed`). A person sees workspace facts, each agent's own facts and the notes agents keep about them, never notes about someone else.
- **Recall in M2 is full-text.** `recall()` uses a stemmed Postgres text search (`memory.content_search`) and needs no embedding model or quota. Vectors join behind the same `MemoryStore` interface later; `memory.embedding_model` records which model made each vector, so the model stays swappable.
- **Post-run extraction runs after the run**, in its own function (ADR-0024): a fast model reads the exchange up to the reply and keeps at most five facts, grouped by whose they are (the person's go to `agent×user`, the team's to `workspace`, the rest to `agent`, each only where the agent may write), plus a one-sentence episode summary. Its model call and memory writes are logged in that run's log, after `run.ended`. Background calls ask the model to answer without long thinking (`LLMRequest.reasoning`).
- **Nightly consolidation** ([ADR-0037](../adr/0037-episodes-scopes-and-nightly-consolidation.md)) runs at 3 at night in each workspace's time zone (or on request): per agent, one fast-model call merges facts that say the same, adds facts its untainted episodes show, and proposes skills for approval; copies, facts unconfirmed for 30 days and facts never recalled in 180 days expire. Nothing is deleted.
- For consequential decisions, agents re-read the source system. Memory guides where to look; it is never the final authority.

---

## 9. Tools and integrations

### 9.1 Three levels

| Level | Concept | Detail |
|---|---|---|
| User | **Connections** | The user signs in once per app through OAuth. Tokens are encrypted in the vault and refreshed in the background. |
| Agent | **Grants** | Per agent, the user picks which discovered tools it may use and sets each to `auto`, `approve` or `blocked`. Defaults come from MCP annotations (`readOnlyHint` → auto, `destructiveHint` → approve). |
| Runtime | **Execution** | The model sees tool names and schemas only. The executor checks policy, injects the token, calls the server and returns a redacted result. |

### 9.2 MCP-first

One generic MCP client (`packages/mcp`) with a database-backed OAuth `authProvider` serves every app that has an official remote MCP server. Tools are discovered with `tools/list`, so adding an app is a catalog entry (`packages/mcp/catalog/*.json`, reviewed against `docs/guides/catalog-review.md`):

```json
{ "id": "notion", "url": "https://mcp.notion.com/mcp", "authOrigin": "https://mcp.notion.com", "setup": "automatic" }
{ "id": "gmail", "url": "https://gmailmcp.googleapis.com/mcp/v1", "authOrigin": "https://accounts.google.com",
  "setup": "own_client", "scopes": ["…/gmail.readonly", "…/gmail.compose"],
  "authorizationParams": { "access_type": "offline", "prompt": "consent" }, "guide": "docs/guides/google-oauth-client.md" }
```

Setup cost per provider:

| Provider | Setup |
|---|---|
| Notion, Linear | None: automatic client registration (DCR). Client ID metadata documents (CIMD) need a public https address for the document, which a self-hosted install doesn't have. |
| GitHub | The self-hoster creates a GitHub OAuth app (GitHub's sign-in has no client registration) and enters its ID and secret on the Connections page ([guide](../guides/github-oauth-app.md)). |
| Google Workspace (Gmail, Calendar, Drive) | **Gmail** has no MCP server here (ADR-0031): it signs in at accounts.google.com directly and uses our tools on the Gmail API, so any Google account works. **Calendar and Drive** use one server per product, all signing in at accounts.google.com. The self-hoster creates their own Google OAuth client ("web application"), enables each product's API and MCP service, and enters it on the Connections page. In "Testing" status refresh tokens expire after 7 days, so the guide moves the app to "In production" (unverified is fine for personal use). Google's MCP servers are in its Workspace Developer Preview Program, which takes Google Workspace accounts only, so Calendar and Drive need one for now ([guide](../guides/google-oauth-client.md)). |
| Slack | The self-hoster creates a Slack app from our manifest (user scopes only: agents act as the person) and keeps it internal to the workspace: Slack lets only internal or directory-published apps use its MCP server. Workspace admin approval may apply, and Slack wants https redirect addresses ([guide](../guides/slack-app-manifest.md)). |

**Signing in** (M4.03). The client is the AI SDK's MCP client (`@ai-sdk/mcp`, used only in `packages/mcp`) with an `authProvider` that keeps everything in Postgres, sealed by the vault:

- The OAuth client registration and the authorization server's details belong to the server (`mcp_server`): registered once per workspace, reused by everyone. Tokens, or the PKCE verifier while signing in, belong to each person's `connection`.
- `POST /api/mcp-servers/:id/connect` returns the provider's sign-in address. The provider sends the person back to `/api/connections/callback` (on `APP_URL`, so no public address is needed), matched to their sign-in by `state` and checked for the issuer. The callback ends on the web app's Connections page.
- **The sign-in site is pinned** (ADR-0018): `auth_origin` comes from the catalog, or from a custom server's first sign-in. A server that later sends sign-in to another origin is refused before anything is fetched from it.
- An expired access token is refreshed on the next 401 and the call retried. A refused refresh marks the connection `needs_reauth` with a plain reason, and tools from that server then say "Sign in to … first".
- **Background refresh** (M4.06): every 10 minutes the `token-refresh` function refreshes sign-ins whose access token runs out within 15 minutes, so a routine after a quiet hour finds them working. Each sign-in is its own step. A refresh never starts a new sign-in:
  - A provider that can't be reached leaves the sign-in as it is, to be tried at the next check.
  - A refused refresh token means `needs_reauth`.
  - A sign-in without a refresh token is left alone until it runs out, then marked `needs_reauth`.
  - Refresh tokens that work only once (Notion's) can race between a run and the check: a refused token right after someone else's refresh counts as refreshed.
  - Finding due sign-ins spans workspaces, so it reads IDs through the owner connection, like vault rotation (§10.4). Each refresh then acts as that person through tenant-scoped queries. Without `DATABASE_MIGRATION_URL` the app warns once, and sign-ins are refreshed when used.
- Custom servers need an owner or admin, an explicit acknowledgement, and an https address; plain http only reaches this computer, and not in production.

**Agents use connected apps** (M4.05). After someone signs in, the server's `tools/list` is kept on its row (and refreshed at `POST /api/mcp-servers/:id/tools/refresh`), so runs don't ask the server each time. Each tool becomes an agent tool:

- **Names:** `notion-search` becomes `notion.search`; the slug is the app part.
- **Hints:** a tool that isn't read-only counts as outbound and, unless it says otherwise, destructive (the MCP default).
- **Results** are outside content, so they taint the run.
- **Sign-in:** calls go out with the sign-in of the person the run works for. Without one, the tool says "Sign in to … first".
- **Grants:** an app granted whole (`notion.*` on auto) lets read-only tools run and has the rest ask first. Naming a tool in a grant is the person's own choice and wins. The agent's Tools step sets both (M4.09): per app Off, "Reads run, changes ask" or "Ask every time", and single tools apart from that, from the kept tool list as agents see it (`GET /api/mcp-servers/:id/agent-tools`). Rules (ask first, allow without asking) are set in Settings.
- **`load_toolkit`:** an app with more than 8 granted tools stays out of the model's list. The agent sees which apps it can load, with their tool names, and loads one for the rest of the run. An app with more than 12 tools is loaded a few at a time: the agent names the tools it needs, and can load more later. This matters for free models' small windows: Notion's server alone offers 46 tools, about 55,000 tokens of schemas. A call to a tool the agent hasn't loaded is answered with how to load it.
- **Hand-written tools on the same sign-in** (ADR-0029): a catalog entry can list its app's own API origins, and our tools reach that API with the person's sign-in through `fetchAs`, never holding the token.
- **Apps without an MCP server** (ADR-0031): a catalog entry of kind `api` has no server. Sign-in goes straight to its `authOrigin`, found through the site's own OAuth or OpenID metadata, with the same PKCE, pinning, vault and refresh. All its tools are ours. Gmail is one: `gmail.search_messages`, `gmail.read_message`, `gmail.create_draft`, `gmail.send_email` and `gmail.send_draft` on the Gmail API, with plain-text email built under strict header rules.

**Every call is checked against the tool's schema before it runs.** Built-in tools declare zod schemas; an MCP tool's JSON Schema is compiled into a validator when the tool is registered (`defineJsonSchemaTool`), and a schema that cannot be checked is refused then, not mid-run. The tool executor validates first, so a malformed call goes back to the model to fix and never reaches policy, the `tool_call` record or the server. The model is shown the server's own schema unchanged.

### 9.3 Built-in capabilities

Hand-written once, available to every agent subject to grants:

`web.search` · `web.read_url` · `browser.*` · `desktop.*` · `shell.run` · `files.*` (including `files.send`) · `docs.create` · `remember` · `recall` · `schedule_task` · `remind_me` · `create_routine` · `message_agent` · `delegate_task` · `ask_user` · `request_approval` · `notify_user` · `todo.*` · `run_skill` · `save_skill` · `use_saved_login` · `load_toolkit`

Web search defaults to self-hosted SearXNG, with Tavily or Exa as optional keyed providers.

### 9.4 Fallback order for apps without an official server

1. Official remote MCP server
2. Community MCP server hosted in the bundle
3. Tools generated from the app's OpenAPI spec
4. A few hand-written tools
5. The agent's browser, with the user taking over for sign-in

---

## 10. Security

### 10.1 Threat model

| Threat | Enters through | Control | Layer |
|---|---|---|---|
| Prompt injection | Emails, web pages, documents, MCP output | Taint escalation, labelled untrusted blocks, read-only proactive mode | L4, L5 |
| Over-permissioned agent | Broad grants | Per-agent grants, risk tiers, always-human list | L5 |
| Credential theft | Vault, logs, sandbox, prompts | Envelope encryption, decrypt only in executor, secret redaction | L5, L9 |
| Host compromise | Agent-run code | Non-root container, no Docker socket, no host mounts, resource limits | L8 |
| Data exfiltration | Sandbox network | Egress allowlist on by default | L8 |
| Exposed instance, CSRF | Local web UI and WebSocket | Bind to `127.0.0.1`, login always, Origin/CSRF checks, Tailscale for remote | L2 |
| Supply chain | Skills, MCP servers, packages | Curated catalog, pinned URLs, skills are instructions only | L5 |
| Memory poisoning | Facts learned from outside content | Unverified memory from tainted runs | L7 |
| Cross-tenant leak | Cloud-mode queries | Row-level security on `workspace_id`, enabled in self-host too | L9 |
| Runaway cost | Loops, broad routines | Budgets, loop detection, routine auto-pause, kill switch | L4, L6 |

These controls respond directly to OpenClaw's 2026 incidents: 42,665 publicly exposed instances, a one-click localhost RCE (CVE-2026-25253), and 341+ malicious skills on ClawHub.

### 10.2 Policy engine

Every source produces a verdict and **the strictest wins**. Nothing later can loosen an earlier result.

| Order | Source | Verdict |
|---:|---|---|
| 1 | Tool not granted to this agent | `deny` |
| 2 | Always-human list: payments, deletions, permission or password changes, external sharing | `human` (takeover or explicit approval) |
| 3 | Destructive annotation | `approve` |
| 4 | Outbound tool, or an address nobody gave the run (ADR-0027), in a tainted run; skipped on a site a person allowed for this task (ADR-0028) | `approve` |
| 5 | Ask-first rule (workspace rules, then personal rules) | `approve` |
| 6 | Allow-auto rule (workspace only), only if nothing above fired | `auto` |
| 7 | Otherwise the grant's mode (annotation defaults) | as configured |

Personal rules can only make workspace rules stricter: they can only ask first, which the database enforces. Rules live in `policy_rule` and are managed at `/api/policy-rules` (workspace rules by owners and admins). A tool is on the always-human list when it declares `humanOnly`, or when its action's words name one (`delete_page`, `create_refund`, `share_file`, `update_permissions`), unless it is read-only (ADR-0028). An LLM reviewer (like Grok Bot's Auto Review) may be added later as one more verdict source; it can add friction but never override deterministic rules.

### 10.3 Taint escalation

Private data + untrusted input + a way to send data out is the dangerous combination. Per run:

```
clean ──reads untrusted content──▶ tainted ──outbound tool call──▶ approval required
```

- A run starts **clean**.
- Reading an inbound email, a web page, a third-party document or external tool output marks it **tainted** until the run ends.
- In a tainted run, any outbound tool (send, post, share, HTTP to a new domain) is escalated to `approve`, whatever its grant says.
- Opening an address counts as outbound when nobody gave it to the run (ADR-0027): in a tainted run, `browser.open`, `web.read_url` and any tool annotated `opensUrl` run freely only for addresses from the conversation or from this run's tool results; an address the agent built (a page can ask for `evil.example/?email=…`) waits for a person.
- **Allow on a site for this task** (ADR-0028): when taint escalation alone holds a call and the tool names its site (browser tools do), the card also offers approving that site for the rest of the run. Calls there stop asking for this reason only; other sites, the always-human list, destructive tools and ask-first rules still ask.
- Approvals (§6.2) pause the run on `step.waitForEvent("approval/decided")`, holding no process, for up to a day; after that the request expires and the model is told. The `approval` row is the truth about the answer; the card says in plain words what the call would do (the tool's `describe`), and appears in the chat, on Home and on the Approvals page.
- **Draft cards** (ADR-0030): a card lists the call's arguments when its summary doesn't say them (every MCP tool), and written text the agent filled in (a message, a title, a comment, never an address or ID, never text holding a secret) can be changed before approving. The call runs with the person's version, checked against the schema again; the model is told what changed, and the run log records the answer as `edited`.
- **Telling the person:** a new request shows a toast wherever they are in the web app, and a desktop notification while the tab is in the background if they turned those on (Settings, per device). Phones and Telegram come in M6.
- Proactive background work uses read-only tools only ([ADR-0038](../adr/0038-proactive-checks-read-only-and-quiet.md)): a routine of kind `check` runs proactive, policy denies anything not annotated read-only or that would need a person, and the check posts only when something needs attention.

### 10.4 Secrets

- Envelope-encrypted vault; values are decrypted only inside the tool executor. Every value has its own data key, wrapped by the vault key and bound to its row (workspace and secret name, or table and row id): named secrets, a connection's tokens and an MCP server's OAuth client alike.
- **The vault key** comes from `VAULT_KEY` or, when running from source on a desktop, the OS keychain (`VAULT_KEY_SOURCE=keychain`: macOS Keychain, the Linux Secret Service, Windows Credential Manager, reached through the OS's own tools with the key on stdin). Containers have no keychain, so the self-host bundle keeps it in its env file.
- **Rotation** re-wraps data keys, not values. The new key becomes current and the old one is kept as a previous key (`VAULT_PREVIOUS_KEYS`, or the keychain's previous entry, set by `pnpm vault keychain:rotate`) until the app, at its next start, has re-wrapped every workspace's values. Listing the workspaces needs the owner connection, as migrations do; each workspace is then re-wrapped through tenant-scoped queries. The app logs when the old key can go, and removes a keychain one itself. `pnpm vault status` shows which key wraps how many values.
- Known secret values are replaced with `[REDACTED]` in tool output, logs and traces (values must be at least 8 characters for reliable redaction). With a workspace in hand, the vault redacts against all of that workspace's secrets, tokens and client secrets: the tool executor for results, errors and held calls, the harness for every run event, approval request and reply. Logs and traces have no workspace, so they redact against everything this process has held in plaintext (the vault's values and the server's own secrets from config). `apps/api/src/redaction.integration.test.ts` checks all of these through the real container.
- Saved passwords are typed into the browser by a tool, never shown to the model. Passwords, 2FA, CAPTCHAs and payments use **computer takeover**.
- Tokens never enter the sandbox. The only credentials in the sandbox are browser sessions the user created there on purpose.

### 10.5 Perimeter and sandbox

- The app binds to `127.0.0.1`. Login is required even locally. HTTP and WebSocket requests are checked for Origin and CSRF.
- Remote and mobile access go through Tailscale. Devices pair with revocable sessions.
- The sandbox (ADR-0025) has no Docker socket, no host mounts (only its own volumes), a read-only root file system and CPU, memory and thread limits. Each agent works as its own Linux user, with a private home and browser profile; only the in-sandbox service runs as root, holding just CHOWN, SETUID, SETGID and KILL, and agent code never runs as root.
- The sandbox sits on an internal network with no route out. Its one exit is the egress proxy: a domain allowlist (`SANDBOX_EGRESS_ALLOW`; `*` allows any public site), ports 80 and 443 only, and never private, loopback, link-local or CGNAT addresses, checked after DNS and connected to the checked address. The app reaches the sandbox service through a forward on the egress container, with a shared token, and never joins the sandbox network.
- **The desktop** (ADR-0040): each agent's display runs a light desktop as that agent (Openbox, a tint2 dock, PCManFM, xterm with tmux, Mousepad, AbiWord, Gnumeric), with its own session bus in a private runtime folder. It starts with the agent's computer, closes after 10 idle minutes, and at most three are open.
- **Watching and takeover** (ADR-0040, superseding ADR-0026): the whole screen is streamed over VNC (x11vnc on 127.0.0.1 inside the sandbox, only while someone watches, bridged by the sandbox service) to `/api/agents/:id/desktop`, behind login and Origin checks; the web app draws it with noVNC. Watchers are view-only; one person at a time can take control, and meanwhile the agent's computer tools are refused. Nothing seen or typed is recorded; start and end are audited. The CDP page stream (`/api/agents/:id/screen`) stays as a fallback.
- **Saved logins** (M3.08): two vault secrets per site, `login.<site>.password` (redacted from all output) and `login.<site>.username`. Only the executor decrypts them, for `use_saved_login`, which types them into a page on that site or its subdomains, never elsewhere. The API lists sites only.
- Agents browse and use desktop apps through the accessibility tree (CDP for pages, AT-SPI for apps, ADR-0041): `desktop.snapshot` lists the window in front (as X reports it) as numbered controls, and `desktop.click`, `desktop.type` and `desktop.press` act on them, each number checked against the control's role and name. Screenshots, clicks at a point and raw typing (`desktop.screenshot`, `desktop.click_at`, `desktop.type_text`) are a fallback, listed only when the run's tier can see images; points are fractions of the screen (free vision models point far better that way, see the vision spike in §19); only the latest screenshot stays in the prompt and the run's state, and each is kept as a run artifact. Clicking, typing, key presses and the shell are outbound tools: after a run reads outside content they need a person's approval (§10.3); proactive checks may use none of them. Opening a file on the desktop (`desktop.open`) is not outbound: it uses only apps that send nothing anywhere, never the browser (ADR-0043).
- **Python and files** (ADR-0042): pip, venv, openpyxl and python-docx are in the image; each agent has its own `~/.venv`, first on its PATH, so packages it installs stay in its home. pip goes through the egress proxy (an allowlist needs `pypi.org` and `files.pythonhosted.org`). `files.send` attaches any file up to 10 MB from the computer to the reply.
- Each agent has its own Chromium profile, so one agent's logins are not available to another unless the user opts in.
- Nothing an agent's computer runs for a person listens on the network, since agents share it: Chromium is driven over its DevTools pipe (`--remote-debugging-pipe`), relayed by the sandbox service, which keeps each connection's commands and page sessions apart; each display has an Xauthority key only its agent reads; desktop viewers use a Unix socket in a folder only that agent and the service can enter.

---

## 11. Reliability

| Concern | Mechanism |
|---|---|
| Crash recovery | Inngest durable steps; a run resumes at the last completed step. |
| Exactly-once side effects | Every tool call has an idempotency key (`runId:step`), recorded `in_flight` before and `done` after. Retries of non-idempotent tools verify first (for example, check the Sent folder). Keys are passed to APIs that accept them. |
| Model outages and limits | Shared queue for each provider's quotas (OpenRouter free: 20 requests/minute); fallback chain per tier, which prefers a model with a free slot over waiting; circuit breaker per model; a 429 pauses only the model that got it unless the provider says the account quota is spent (OpenRouter returns 429 when one free model's host is busy); `ModelError` with `retryAfterMs` so the run waits ("waiting for model capacity") instead of failing. |
| Run log integrity | Each `run_event` carries a writer-chosen `key` (`model-3`, `tool-3-0`), unique per run, so a retried step never writes twice; the database assigns `seq` under a lock on the run row. Once a run has ended its log is closed: only `run.ended` is accepted, plus `learn-` events after a success (ADR-0024), so a step still in flight when Stop is pressed adds nothing. |
| Long waits | Approvals and scheduled wake-ups use `waitForEvent` and `sleepUntil`, which hold no process or memory. |
| Runaway work | Per-run step, token and cost budgets; loop detection; routines auto-pause after long user inactivity; kill switch per agent and workspace. |
| Backpressure | Per-agent concurrency keys; per-connector rate limits in the executor; routines are skipped, not queued without bound, when an agent is saturated. |

---

## 12. Observability and evals

**Observability**

- One OpenTelemetry trace per run; spans per model call and tool call.
- Span attributes: latency, tokens in/out, cost, model and prompt version, policy verdict, taint state, retries, errors.
- Traces contain user data (emails, documents), so they stay on the user's machine: an optional Phoenix container in self-host mode, Langfuse or Grafana in cloud mode.
- The same `run_event` log powers the Activity view.

**Evals** (`evals/`)

- **Golden suites** per agent role: tasks with rubrics, graded on both the end state and the transcript.
- **Red-team suite:** injection and exfiltration attempts that must end in `approve` or `deny`.
- **Fixtures:** mock MCP servers, seeded inboxes and CRMs, recorded responses. Evals never touch real accounts.
- **Graders:** rule-based state checks, LLM-judge rubrics calibrated against human review.
- **Metrics:** pass@1 and pass^k; approval rate; intervention rate; cost per task.
- **Team cases** (M5.13): a case may give the agent teammates; `delegate_task` runs each child on the same harness, tools and policy from its brief (one level), and checks read each handoff's tools, reply and taint.
- Evals run in CI whenever a prompt, tool, policy or model-tier mapping changes. A model must pass evals before a tier can use it.
- **How a case runs.** `pnpm eval` runs each case against live models through the real gateway, harness, tool executor and policy engine, in an in-memory world: no database, and web search and page reads come from fixtures. `--model provider:model` puts one model in every tier, to qualify it; `--k` repeats attempts for pass^k. The runner's own tests use a scripted model, so `pnpm test` needs no key.

---

## 13. Clients and channels

All clients are thin: they render chat, approvals and activity, and every action goes through the same API. No channel requires a public URL.

| Channel | Transport | Public URL? | Best for |
|---|---|---|---|
| Web app (Vite SPA) | HTTPS + WebSocket to the API | No | Setup, chat, Activity view, watching and taking over the computer |
| Mobile (Expo) | HTTPS + WebSocket over Tailscale; Expo push | No | Chat, approvals, notifications, takeover, routine status |
| Telegram | Bot API long polling | No | Chat and approvals from any phone without our app |
| Slack | Socket Mode | No | Working where the team already talks |
| Email | Forwarding relay to the agent's address | Relay only | Handing agents documents and threads (later) |

**Pairing a phone**

1. The web app shows a QR code with the server URL and a one-time code valid for five minutes.
2. The phone joins the user's tailnet.
3. The app scans the code and calls `POST /devices/pair`.
4. The server issues a device session, listed and revocable in Settings.
5. The app registers its Expo push token.

**Shared client code:** web and mobile import only `core`, `contracts` and `client`. Hooks (`useAgents`, `useRun`, `useApprove`) are written once; UI is written twice (shadcn/ui on web, NativeWind on mobile) from one token preset. A desktop app can later wrap the SPA with Tauri.

**Chats per agent** (UX.13): a person can have several direct threads with one agent. The current chat is the one used most recently; New chat starts another (an empty current chat is reused), so old topics stay out of new tasks. History lists them by last use with search over every message; archiving hides a chat without deleting it, and renaming or archiving never changes the order. The harness reads history from the run's own thread only.

**Reply blocks** (UX.16): besides Markdown, a reply may hold a fenced `chart` spec (bar or line, up to four series), checked against `chartSpecSchema` in `@ofa/contracts` and drawn as SVG with values printed and a table view. An invalid spec stays as code; nothing the model writes runs.

**UX patterns adopted from Grok Bot:** editable draft cards for outbound messages; "needs attention / unread / working" states (unread per person and chat from `thread_member.last_read_at`, M5.11); `/` for skills and `@` for agents, groups and connectors; direct messages preempt background work; a secure secret-input component that never enters the transcript.

---

## 14. Deployment

### 14.1 Self-hosted bundle

`infra/compose/docker-compose.selfhost.yml`, about 2.5–3.5 GB RAM in total:

| Container | RAM | Role | Exposure |
|---|---:|---|---|
| `app` | ~500 MB | API, Inngest functions, channel listeners and built web app in one Node process | `127.0.0.1:3000` |
| `postgres` | 300 MB – 1 GB | Postgres 17 + pgvector: app data, vectors, Inngest state, event bus | Internal |
| `inngest` | ~200 MB | Self-hosted durable execution engine and dashboard | Internal; dashboard via Tailscale |
| `sandbox` | up to 1.5 GB (three desktops measured at 0.9–1.2 GB, DT.13) | Our slim image (ADR-0025): a light desktop and Chromium per agent on demand (at most three open, ADR-0040), shell, files, Python with a venv per agent (ADR-0042), each agent as its own user | Internal network only |
| `egress` | ~30 MB | The sandbox's only exit: an allowlisting HTTP(S) proxy that never reaches private addresses; forwards the app to the sandbox service | Internal |
| `phoenix` (optional) | ~300 MB | Local trace viewer | Profile `observability` |
| `ollama` (optional) | Model-dependent | Local models | Profile `local-models` |

Outbound connections: OpenRouter, MCP servers, allowlisted sites the sandbox visits, Expo push, Telegram, Slack.

Always-on hosting options for users: a spare Mac mini or laptop, a Raspberry Pi 5 (8 GB), or their own Oracle Cloud Always Free VM (2 OCPU / 12 GB ARM; all images must ship arm64).

Backups: `infra/scripts/backup.sh` runs a nightly `pg_dump`.

### 14.2 Cloud mode

Same code, different adapters (see [§4](#4-core-interfaces)). Process layout changes to API replicas, a worker pool scaled on queue depth, the web build on a CDN, managed Postgres, Valkey, E2B sandboxes, KMS and Langfuse or Grafana.

---

## 15. Data model

Every table carries `workspace_id` and is protected by row-level security. Run tables are append-only.

**Exception: identity.** Better Auth's `user`, `session`, `account` and `verification` tables are global, because one person can belong to several workspaces and sign-in happens before a workspace is known. A user reaches workspace data only through `membership`, which is under RLS ([ADR-0020](../adr/0020-identity-tables-outside-tenant-rls.md)).

| Group | Tables |
|---|---|
| Tenancy | `workspace`, `user`, `membership`, `device` |
| Agents | `agent` (spec, autonomy, budgets), `agent_grant`, `skill`, `routine` (cron, time zone, its own chat, `next_run_at`) |
| Connections | `connection` (one person's sign-in to a server; encrypted tokens), `mcp_server` (catalog entries and custom servers installed in the workspace; pinned URL and auth origin, encrypted OAuth client), `secret` (named, redacted) |
| Conversations | `thread` (direct, group with a coordinator, handoff), `thread_member` (users and agents; a person's `last_read_at`), `message`, `thread_state` (each agent's working record in a chat, ADR-0045) |
| Execution | `run` (trigger, `parent_run_id`, `routine_id`, `proactive`), `run_event`, `tool_call` (idempotency), `approval`, `artifact` |
| Memory | `memory` (typed, scoped, `verified` flag), `episode`, `schedule` (a task or reminder for later) |
| Governance | `policy_rule` (ask-first or allow-auto, per tool pattern, workspace-wide or one person's; personal rules can only ask first), `audit_log` (append-only) |

---

## 16. Decision log

Summary only. Full records (context, decision, alternatives, consequences) are in [`docs/adr/`](../adr/README.md).

| ADR | Area | Decision | Key reason |
|---|---|---|---|
| [0001](../adr/0001-self-hosted-first.md) | Platform | Self-hosted first, multi-tenant-ready data | Zero infra cost; user data stays local; cloud later is additive |
| [0002](../adr/0002-thin-clients-hono-vite-expo.md) | Clients | Thin clients over one Hono API; Vite SPA web; Expo mobile | Mobile needs a real API; WebSockets; one process for self-host; no SEO need |
| [0003](../adr/0003-monorepo-pnpm-turborepo.md) | Platform | pnpm + Turborepo monorepo with enforced import boundaries | Shared contracts across API, worker, web and mobile |
| [0004](../adr/0004-postgres-pgvector-bundled.md) | Platform | Postgres 17 + pgvector bundled (not Neon) | Always-on worker exhausts Neon's free compute in ~16 days; 0.5 GB limit |
| [0005](../adr/0005-drizzle-orm.md) | Platform | Drizzle over Prisma | First-class pgvector; RLS in migrations; no generate step |
| [0006](../adr/0006-inngest-durable-execution.md) | Runtime | Self-hosted Inngest for durable execution | Resume after crash; free approval waits; cron; concurrency; no execution cap |
| [0007](../adr/0007-event-bus-interface.md) | Runtime | Event bus: `LISTEN/NOTIFY` self-host, Valkey cloud | One fewer container at home |
| [0008](../adr/0008-model-gateway-ai-sdk-openrouter.md) | Runtime | Model gateway on AI SDK + OpenRouter (user key) + Ollama | Tool calling, MCP client; shared 20 req/min queue; fallback |
| [0009](../adr/0009-sandbox-provider-local-docker.md) | Computer | `SandboxProvider`: local Docker first, E2B adapter (image choice superseded by 0025) | Free and local; E2B credit is finite |
| [0010](../adr/0010-per-agent-browser-profiles.md) | Computer | One computer per user, one browser profile per agent | Grok Bot's shared logins are its weakest boundary |
| [0011](../adr/0011-mcp-first-integrations.md) | Integrations | MCP-first integrations with a catalog | Vendors maintain tools; adding an app is config |
| [0012](../adr/0012-credentials-never-reach-model.md) | Security | Credentials never reach the model or the sandbox | An injected agent cannot leak what it never saw |
| [0013](../adr/0013-policy-engine-taint-escalation.md) | Security | Policy engine: strictest verdict wins, taint escalation | Deterministic; does not rely on the model resisting injection |
| [0014](../adr/0014-run-as-unit-of-truth.md) | Runtime | The run is the unit of truth (append-only events) | One log for activity, traces, evals, audit, recovery |
| [0015](../adr/0015-idempotent-side-effects.md) | Runtime | Exactly-once side effects via idempotency keys | Prevents double sends after a crash |
| [0016](../adr/0016-channels-without-public-url.md) | Clients | Channels that need no public URL | Home machines cannot receive webhooks |
| [0017](../adr/0017-local-first-perimeter.md) | Security | Local-first perimeter (localhost, login, CSRF, pairing) | OpenClaw's exposed instances and localhost RCE |
| [0018](../adr/0018-curated-catalog-no-marketplace.md) | Security | Curated catalog, no open skill marketplace | 12–20% of ClawHub skills were malicious |
| [0019](../adr/0019-observability-opentelemetry.md) | Runtime | OpenTelemetry, traces kept local by default | Traces contain user data; backend stays swappable |
| [0020](../adr/0020-identity-tables-outside-tenant-rls.md) | Security | Identity tables outside tenant RLS; workspace access only via `membership` | One person, many workspaces; sign-in precedes tenancy |
| [0021](../adr/0021-api-client-from-contracts.md) | Clients | API client built from contracts schemas, not Hono RPC | Keeps rule R1; validates responses at runtime |
| [0022](../adr/0022-replaceable-model-providers.md) | Runtime | Model providers behind `ModelProvider`, one file each; `LLM_PROVIDER` picks | Switch providers by changing one module and one setting |
| [0023](../adr/0023-familiars-and-voice.md) | Clients | Familiar avatars from fixed parts, derived moods, four voice presets as a versioned prompt fragment | Agents easy to tell apart; tone never touches permissions |
| [0024](../adr/0024-learning-after-the-run.md) | Runtime | Memory extraction runs in its own function after a run succeeds; closed log accepts `learn-` events | The agent is free for the next message as soon as it replies |
| [0025](../adr/0025-own-slim-sandbox-image.md) | Computer | Our own slim sandbox image; one Linux user per agent; one exit through an egress proxy | AIO was 3.6 GB compressed with unused services, and one user would let agents read each other's logins |
| [0026](../adr/0026-watch-and-takeover-over-cdp.md) | Computer | Watch and take over the browser over CDP, not VNC (superseded by 0040) | Nothing but Chromium is on screen; no VNC server or client dependency |
| [0027](../adr/0027-address-provenance-in-tainted-runs.md) | Security | In a tainted run, open only addresses the run was given | A page could make the agent carry data out in an address; per-domain approval would stop research |
| [0028](../adr/0028-site-answers-and-the-always-human-list.md) | Security | Approve a site for one task; classify the always-human list by name | One form took 13 approvals; MCP tools don't say which are payments or deletions |
| [0029](../adr/0029-tools-beside-an-mcp-server.md) | Integrations | A few hand-written tools beside an MCP server, on its sign-in | Google's Gmail server can't send; a second sign-in for the same account gains nothing |
| [0030](../adr/0030-edit-before-approving.md) | Security | Change a held call's written text before approving | The draft card; denying to fix one word costs a model turn and a second approval |
| [0031](../adr/0031-gmail-through-googles-api.md) | Integrations | Gmail through Google's own API, with a direct Google sign-in | Google's Gmail MCP server takes Workspace accounts only; most self-hosters have personal accounts |
| [0032](../adr/0032-delegation-one-level-from-a-brief.md) | Runtime | Delegation goes one level deep, from a brief, with taint carried both ways | Loops between agents burn the quota; a brief written after an injected email must not escape approval |
| [0033](../adr/0033-group-threads-and-agent-messages.md) | Runtime | Group threads give each message one responder; agents message each other one hop | Several agents answering at once, or waking each other in a loop |
| [0034](../adr/0034-interrupts-steer-stop-preempt.md) | Runtime | A person's message steers the run in its chat, "stop" halts it, and routines yield | Cancelling and restarting on every message; a separate steer endpoint |
| [0035](../adr/0035-routines-and-prospective-memory.md) | Runtime | Routines fire from a minute tick; tasks and reminders sleep until due | One Inngest cron per routine; a cron library from npm |
| [0036](../adr/0036-skills-are-reviewed-instructions.md) | Runtime | Skills are reviewed instructions, applied by `/name` or `run_skill` | Executable skills; approving every skill |
| [0037](../adr/0037-episodes-scopes-and-nightly-consolidation.md) | Runtime | Episodes for every run, facts filed by whose they are, and a nightly pass that only expires | A model call per episode; hard deletes; re-scoping by a model |
| [0038](../adr/0038-proactive-checks-read-only-and-quiet.md) | Security | Proactive checks are read-only routines that never wait and speak only when needed | A prompt-only rule; checks that wait for approvals |
| [0039](../adr/0039-agent-files-and-unread.md) | Product | Agents travel as JSON files and arrive held for review; unread is per person and per chat | YAML files; importing skills and routines live; client-side unread |
| [0040](../adr/0040-light-desktop-watched-over-vnc.md) | Computer | A light desktop per agent (Openbox, not XFCE), watched and taken over over VNC | People want to see the terminal, files and documents, not just the page; XFCE's RAM does not fit three agents |
| [0041](../adr/0041-desktop-apps-accessibility-tree-first.md) | Computer | Desktop apps through the accessibility tree first; screenshots only when the model reads images | Screenshots cost a vision model, a call per click and much of a small context |
| [0042](../adr/0042-python-packages-and-office-files.md) | Computer | pip and a venv per agent; openpyxl and python-docx in the image; `files.send` sends any file back | Word and Excel files need libraries, and a file made by a script must reach the person |
| [0043](../adr/0043-opening-a-file-on-the-desktop-is-not-outbound.md) | Security | Opening a file on the desktop is not outbound; never in the browser | An approval card each time a researched report is shown, for an action that can't send anything |
| [0044](../adr/0044-team-roster-from-grants-coordinators-delegate.md) | Runtime | Capability cards from grants in every roster; coordinators plan, delegate first and lose the tools a teammate covers | A chief of staff did the research itself; a prompt rule per agent was ignored and doesn't scale |
| [0045](../adr/0045-a-chat-keeps-its-working-state.md) | Runtime | Each agent keeps a working record per chat (plan, ledger, notes), saved as the run goes and shown to the next run | "Continue" after a budget stop started over: nothing but chat text reached the next run |
| [0046](../adr/0046-public-site-and-docs-as-their-own-app.md) | Clients | The landing page and docs are `apps/site`, a static Vite app on Vercel that reads the decision records at build time | Docs that can't drift; the real familiars and routing on the page; no server code in public |

**Rejected along the way:** Next.js (mobile and WebSocket fit), Express (untyped), Neon (free-tier limits), Prisma (vector support), BullMQ (no durable waits), Inngest Cloud (execution caps), Composio (lock-in and pricing), E2B-only (finite credit), hosted-only (cost and data custody).

---

## 17. Repository layout

The root holds workspace configuration only. Deployable programs live in `apps/`, libraries in `packages/`, and every other concern has one named folder.

```
one-for-all/
├── apps/                         deployable programs (thin composition roots)
│   ├── api/                      Hono backend: REST + WS, auth, approvals, pairing
│   │   └── src/
│   │       ├── routes/           one file per resource; validate with contracts
│   │       ├── ws/               realtime gateway fed by the event bus
│   │       ├── middleware/       auth, TenantContext, Origin/CSRF, rate limits
│   │       ├── oauth/            MCP and channel OAuth callbacks
│   │       ├── container.ts      composition root: picks adapters by mode
│   │       └── server.ts         entry; mounts Inngest + web build in self-host
│   ├── worker/                   cloud scale-out process
│   │   └── src/
│   │       ├── listeners/        telegram-poller.ts, slack-socket.ts
│   │       ├── container.ts
│   │       └── server.ts
│   ├── web/                      Vite + React SPA
│   │   └── src/
│   │       ├── routes/           TanStack Router file routes
│   │       ├── features/         chat, agents, approvals, activity, computer,
│   │       │                     connections, routines, memory, settings
│   │       ├── components/ui/    shadcn/ui primitives
│   │       └── lib/              client instance, WS hook, formatters
│   ├── site/                     public landing page and docs: static Vite app on Vercel (ADR-0046)
│   └── mobile/                   Expo app (iOS/Android)
│       ├── app/                  Expo Router screens
│       └── src/
│           ├── features/         mirrors web features, native UI
│           └── notifications/    push registration, deep links
├── packages/                     libraries: src/, one index.ts, *.test.ts beside code
│   ├── core/                     domain types + all interfaces; depends on nothing
│   ├── contracts/                zod schemas for API and events   (browser-safe)
│   ├── client/                   typed API client + Query hooks   (browser-safe)
│   ├── db/                       Drizzle: schema/, migrations/, rls/, seed/
│   ├── orchestrator/             Inngest client + functions
│   ├── harness/                  loop/, context/, middleware/, compaction/
│   ├── llm/                      providers/ (one file each), tiers, queue, fallback, metering
│   ├── tools/                    registry + built-in tools
│   ├── mcp/                      MCP client, OAuth provider, catalog/
│   ├── policy/                   grants, rules, risk tiers, taint
│   ├── memory/                   stores, recall, extraction, consolidation
│   ├── sandbox/                  docker + e2b adapters, CDP browser, page snapshots, screen and desktop streams
│   ├── channels/                 web, telegram, slack, email adapters
│   ├── vault/                    encryption, secret refs, redaction
│   ├── events/                   event bus adapters + typed event catalog
│   ├── telemetry/                OpenTelemetry setup and span helpers
│   └── config/                   zod env schema, self-host/cloud mode
├── tooling/                      shared dev config
│   ├── tsconfig/                 base, node, react, react-native presets
│   ├── eslint/                   presets + import-boundary rules
│   └── tailwind/                 token preset for Tailwind and NativeWind
├── infra/
│   ├── docker/                   app/worker Dockerfiles, sandbox/ image (service + egress proxy)
│   ├── compose/                  selfhost.yml, dev.yml, optional profiles
│   └── scripts/                  install, backup, restore, upgrade
├── evals/                        @ofa/evals; `pnpm eval`
│   ├── suites/                   golden tasks with rubrics, by agent role
│   ├── redteam/                  injection and exfiltration cases
│   ├── fixtures/                 recorded web pages, mock MCP servers, seeded inboxes and CRMs
│   └── graders/                  state checks, LLM judges, pass^k runner, CLI
├── docs/
│   ├── architecture/             ARCHITECTURE.md (this file)
│   ├── adr/                      one file per decision
│   ├── planning/                 TRACKER.md: milestones, tasks, session log
│   └── guides/                   google-oauth-client, slack-app-manifest, site-on-vercel, tailscale, backups
├── .github/workflows/            ci.yml (lint, typecheck, test, evals), release.yml
├── package.json                  workspace scripts only
├── pnpm-workspace.yaml
├── turbo.json
├── .env.example
├── README.md
└── LICENSE
```

### Dependency rules

| Rule | Statement |
|---|---|
| R1 | Apps depend on packages. Packages never import from apps; apps never import from each other. |
| R2 | `core` imports nothing internal. Every other package may import `core`. |
| R3 | Web, mobile and the public site import only browser-safe packages: `core`, `contracts`, `client`. Server imports are a lint error. |
| R4 | Adapters implement a `core` interface and are chosen only in a composition root (`container.ts`). |
| R5 | Each package exposes one public `index.ts` through its `exports` field. Deep imports are lint errors. |
| R6 | Unit tests sit next to the code as `*.test.ts`. Cross-package agent behavior is tested in `evals/`. |
| R7 | No source code at the root. A new top-level folder needs an ADR. |

---

## 18. Build order

Each milestone is a thin vertical slice through every layer and ends with something that runs. Task-level progress is tracked in [docs/planning/TRACKER.md](../planning/TRACKER.md).

| Milestone | Scope |
|---|---|
| **M1 Foundation** ✅ | Monorepo, tooling, config schema, Drizzle schema with RLS, auth, compose bundle, CI. |
| **M2 First agent** ✅ | Harness loop, model gateway, run events, web chat and Activity view, built-in web search and memory. |
| **UX Experience pass** ✅ | Collapsible shell and command palette, chat layout with a live familiar loader, full markdown with sources, summary-first Activity, home and agents pages, chats and history, memory review, toasts with Undo, chart blocks, a phone pass. |
| **M3 The computer** ✅ | Docker sandbox, browser with per-agent profiles, watching and takeover, saved logins, artifacts; approve or deny cards, brought forward from M4. |
| **M4 Integrations and policy** ✅ | MCP client and OAuth, catalog, grants UI, the full policy engine and rules, approval draft cards (edit before sending); Gmail on Google's own API. |
| **M5 The team** ✅ | Delegation and fork-join, agent messages and group threads, interrupts, routines and read-only checks, tasks and reminders for later, skills, episodes and nightly memory consolidation, agent files, the team screens, multi-agent evals. |
| **Desktop** ✅ | A light desktop per agent watched over VNC, the agent's work shown on it, Python packages and office files, `files.send` and a Files tab, desktop apps through the accessibility tree with a screenshot fallback. |
| **Teams and continuity** | A chat record per agent so work continues across runs; stop replies and a budget warning; capability cards in the roster; a coordinator role that delegates first; handoffs that pass results by name and show in the chat. Done (11 tasks). |
| **M6 Everywhere** | Expo app with pairing and push, Telegram and Slack channels. |
| **M7 Hardening** | Eval suites and red-team set in CI, backups, E2B adapter, cloud-mode adapters. |

---

## 19. Open questions

- **License.** Open source (Apache-2.0 or AGPL) vs source-available, given a possible hosted version.
- **Gmail in cloud mode.** A hosted version needs Google verification and a yearly CASA assessment for restricted scopes.
- **Model tiers.** Provisionally answered by the M2.05 spike (below); free models change often, so `pnpm eval --model <provider:model>` re-qualifies one against the eval cases and `pnpm --filter @ofa/llm spike` re-runs the tool-calling check.
- **E2B cost in cloud mode.** Whether pause/resume keeps per-user sandbox cost acceptable, or cloud users bring their own key.
- **Inbound email.** Which relay to use without requiring a public URL on the user's machine.
- **LLM reviewer.** Whether a cheap-model action reviewer adds enough safety to justify its latency and quota.

---

### Model tier spike (2026-10-02)

Six tool-calling tasks per model, two runs each, all 16 free OpenRouter models with tool support, through the real gateway and its shared queue (192 calls). Tasks: one obvious tool call; picking the right tool from three; answering without a tool; structured arguments (date-time, integer, list of emails); answering from a tool result without searching again; two lookups in one turn.

| Model | Passed | Median latency | Notes |
|---|---:|---:|---|
| `cohere/north-mini-code:free` | 12/12 | 1.6 s | Clean on every task |
| `dots-studio/dots-3-note-preview:free` | 12/12 | 2.0 s | Clean; a preview, may be withdrawn |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 11/12 | 4.4 s | Upstream overloads |
| `nvidia/nemotron-3.5-lightning:free` | 8/12 → 10/12 | 1.8 s | Two "fails" were a grader bug (narrow no-break space in the date); looks up one city per turn |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 9/12 | 4.6 s | Largest; often overloaded upstream, so it needs fallbacks |
| `nvidia/nemotron-3-super-120b-a12b:free` | 8/12 | 2.5 s | Sometimes searches again after it has the answer |
| `apodex/apodex-1.1-mini:free`, `inclusionai/ling-3.0-flash-sante:free`, `liquid/lfm-2.5-2.6b:free` | 10/12 | 1.3 s | Fast; search again instead of using the result |
| `qwen/qwen3.8-27b:free`, `poolside/laguna-s-2.1:free`, `poolside/laguna-xs-2.1:free` | 7–8/12 | 0.9–4.7 s | Frequent upstream rate limits |
| `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free` | 0–1/12 | – | Almost always rate-limited upstream |
| `thinkingmachines/inkling:free`, `inkling-small:free` | 0/12 | – | HTTP 403: reserved for apps on OpenRouter's list |

**Defaults chosen** (`packages/llm/src/providers/openrouter.ts`), each chain mixing upstream hosts:

- **fast:** nemotron-3.5-lightning → north-mini-code → ling-3.0-flash
- **standard:** dots-3-note-preview → north-mini-code → nemotron-3-super
- **strong:** nemotron-3-ultra → nemotron-3-super → dots-3-note-preview

**What the spike changed in the gateway:** a 429 pauses only the model that got it (OpenRouter sends 429 when one free model's host is busy), and a 403 refuses one model, not the key, so the chain moves on instead of giving up on the provider.

**Limits of this check:** 12 calls per model is a smoke test, not a quality bar. Free models are unpredictable from hour to hour (Gemma and Qwen were usable in the catalog but not in practice). The agent loop must tolerate a redundant tool call (loop detection, §6.2) and sequential rather than parallel calls.

### Vision spike (2026-10-11)

Which free models can act on a screenshot of an agent's desktop (DT.10)? `pnpm --filter @ofa/llm spike:vision` sends a real 1280×800 screenshot (`evals/fixtures/desktop/desktop-apps.png`: AbiWord in front, Gnumeric and the Agent terminal) to each free OpenRouter model that takes images and tools, through the real gateway: click Gnumeric's File menu, click the Agent terminal in the dock, and name the file in the window in front; the clicks asked once in pixels and once in fractions of the screen.

| Model | Read the screen | Clicks, pixels | Clicks, fractions |
|---|:-:|:-:|:-:|
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | ✓ | 1/2 (answered in fractions anyway) | 2/2 |
| `dots-studio/dots-3-note-preview:free` | ✓ | 0/2 | 1/2 |
| `google/gemma-4-26b-a4b-it:free` | ✓ | 0/2 | 1/2 |
| `google/gemma-4-31b-it:free` | ✓ | 0/2 | 0/2 (2 px off the menu) |
| `thinkingmachines/inkling:free`, `inkling-small:free` | ✓ | 0/2 | 0/2 (no clicks) |

**Chosen:** `desktop.click_at` takes fractions of the screen (pixels still accepted above 1); the default vision chain is dots-3-note-preview → nemotron-3-nano-omni → gemma-4-26b → gemma-4-31b (`OPENROUTER_DEFAULT_VISION`, overridden by `LLM_MODELS_VISION`). Nemotron points best but led only until the end-to-end check (DT.13): its answers carried its reasoning, and one broke down into `<unk>` tokens, so dots, which read every screen right and answers cleanly, goes first. A request with images tries the vision chain first, then the tier's own models that read images. Every model read the screen right, so reading a screenshot is reliable; pointing is the weak part, which is why the accessibility tree comes first (ADR-0041).

---

## 20. References

- OpenAI, *Introducing dots* — https://openai.com/index/introducing-dots/
- xAI, *Grok Bot* docs — https://docs.x.ai/grok-bot/overview
- Model Context Protocol, *Authorization* (2025-11-25) — https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- AI SDK, *MCP tools* — https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- Inngest, *Self-hosting* — https://www.inngest.com/docs/self-hosting
- agent-infra, *AIO Sandbox* — https://github.com/agent-infra/sandbox
- E2B, *Sandbox persistence* — https://e2b.dev/docs/sandbox/persistence
- OpenClaw docs — https://docs.openclaw.ai/
- The Hacker News, *341 malicious ClawHub skills* — https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html
- Interactive version of this document — https://claude.ai/artifact/JXeSmvisButUN45ZQkRffM (private to the owner)
