---
title: The big picture
summary: What One-for-All is, the words it uses, its layers, the rules every line of code follows, and the tools it is built with.
---

## What it is

One-for-All is a platform you run on your own computer or server, where a **team of AI agents** works for you. Each agent has **one job** (a researcher, an inbox clerk, a video editor), its **own computer** (a sandboxed Linux desktop with a browser and a terminal), the **tools you grant it**, and a **memory**. You talk to agents in chats from a web app; they can hand work to each other, run on a schedule, and they **ask before doing anything that leaves the system**, like sending an email.

Under the hood it is a full-stack TypeScript application: a React web app, an HTTP API, a Postgres database, a job runner for long work, and an "agent loop" that talks to language models. This guide walks through all of it.

## The words it uses

| Word | Means | Where it lives |
|---|---|---|
| **Workspace** | Everything one person or team owns. Every row in the database belongs to one. | [workspace](table:workspace) |
| **Agent** | A worker with a job, rules, a model tier, budgets and grants. Stored as a spec, read at the start of every run. | [agent](table:agent) |
| **Familiar** | An agent's avatar. Only the picture. | `apps/web/src/components/familiar.tsx` |
| **Thread** | A chat: direct (you and one agent), group (two to six agents), or a handoff between agents. | [thread](table:thread) |
| **Run** | One execution of an agent, from a message to its reply. Every step is logged. | [run](table:run), [run_event](table:run_event) |
| **Tool** | Something an agent can do: search the web, click in a browser, create a draft. | [Agent tools](/tools) |
| **Grant** | Permission for an agent to use a tool: automatically, after asking you, or never. | [agent_grant](table:agent_grant) |
| **Approval** | A held tool call waiting for you to say yes or no. | [approval](table:approval) |
| **Taint** | A run that read outside content (a web page, an email) is "tainted": anything it sends out needs your approval. | [ADR-0013](adr:0013) |

## The layers

The code is split into layers. **A layer only calls the layers below it**, never above. The web app never touches the database; the API never runs an agent; the agent loop never knows which database or sandbox it runs on.

```layers
Clients | The web app and the public site: what people see | apps/web, apps/site, packages/client
API | HTTP and WebSocket: sign-in, chats, agents, approvals | apps/api
Orchestration | Durable background jobs: when an agent runs, retries, schedules | packages/orchestrator (Inngest)
Agent harness | The agent loop: prompt, model call, tools, stop | packages/harness, packages/llm
Tools and policy | Every tool call checked by policy, then run | packages/tools, packages/policy, packages/mcp, packages/vault
Memory and the computer | What agents remember; each agent's sandbox | packages/memory, packages/sandbox, packages/video
Data | Postgres with row-level security; the event bus | packages/db, packages/events
Foundations | Types, ports, zod contracts, config | packages/core, packages/contracts, packages/config
```

### Ports and adapters

How can the agent loop save a message without knowing about Postgres? It talks to an **interface** (a "port") defined in `packages/core`, and something else provides the implementation (an "adapter"). For example, the loop only knows a `ThreadStore`:

```code
packages/core/src/ports/runtime.ts#ThreadStore
```

The Postgres implementation lives in `packages/db`. The one place that picks adapters and wires them together is the **composition root**, `createContainer` in the API (hard rule 2: no `if (mode === "cloud")` anywhere else):

```code
apps/api/src/container.ts#createContainer
from: const runs = createRunStore(db, { publish });
to: const memory = createPgMemoryStore(db);
title: The container plugs Postgres in behind the ports
```

This is why the same harness runs in tests with in-memory stores (see `createMemoryRuntime` in [packages/harness](pkg:harness)), in the evals, and in production, unchanged.

## The eight hard rules

These are written in the repository's `CLAUDE.md` and [the architecture document](https://github.com/Bhuvan-S-prasad/one-for-all/blob/main/docs/architecture/ARCHITECTURE.md). Code that breaks one is a bug, even if it works.

1. **Layering.** A layer only calls layers below it. Lint rules enforce which package may import which.
2. **Composition roots.** Adapters are chosen only in `container.ts`.
3. **Tenancy.** Every table has `workspace_id`; every query goes through [withTenant](code:packages/db/src/tenant.ts#withTenant), and Postgres row-level security stays on. See the [data model](/data).
4. **Credentials.** Tokens and secrets are decrypted only inside the tool executor, never put in prompts, logs or the sandbox. See [packages/vault](pkg:vault).
5. **Policy in code.** Every tool call goes through the [policy engine](code:packages/policy/src/engine.ts#createPolicyEngine); the strictest verdict wins. A permission is never just a sentence in a prompt.
6. **Durability.** Side effects happen inside durable steps, so a crash or a retry never does anything twice. See [Jobs and events](/jobs).
7. **Run log.** Every model call, tool call, verdict and approval is appended to the run's log; past events never change.
8. **Perimeter.** The app listens on `127.0.0.1`, needs a login, and checks the Origin of every request. Agent code runs only in the sandbox.

## The stack, and why

| Piece | What it does here | Where |
|---|---|---|
| **TypeScript** everywhere | One language from the database schema to the React components; types shared across the network | every package |
| **pnpm + Turborepo** | A monorepo: many packages in one repository, built and tested together | the root |
| **React + TanStack Router/Query** | The web app's screens, routing and server data | [apps/web](pkg:web), [packages/client](pkg:client) |
| **Hono** | A small, typed HTTP framework for the API | [apps/api](pkg:api) |
| **zod** | Schemas for every request, response and event, shared by server and client | [packages/contracts](pkg:contracts) |
| **Postgres + Drizzle** | The database, with pgvector for memory; Drizzle declares tables in TypeScript | [packages/db](pkg:db) |
| **Inngest** (self-hosted) | Durable jobs: agent runs that survive crashes, waits and retries | [packages/orchestrator](pkg:orchestrator) |
| **AI SDK + OpenRouter** | One gateway to many language models, with fallbacks | [packages/llm](pkg:llm) |
| **MCP** | The standard protocol for connecting apps (Gmail, Notion…) as tools | [packages/mcp](pkg:mcp) |
| **Docker** | Each agent's computer is a container; the whole system ships as Docker Compose | [packages/sandbox](pkg:sandbox) |

Why these and not others (for example why not Next.js, Express or Prisma) is written down in the [decisions](/decisions); [ADR-0006](adr:0006) explains Inngest, for instance.

## How a message becomes a reply, in one breath

```flow
You write in the web app | The composer sends POST /api/threads/:id/messages
The API stores it | The message and a queued run are saved together, and an event goes to Inngest
!The agent runs | Inngest starts the agent loop, which calls the model, uses tools (each checked by policy) and writes a reply
You see it live | Saving the reply notifies the API, which pushes it to your browser over a WebSocket
```

The [walkthrough](page:walkthroughs/send-a-message) follows this path stop by stop, with the real code at each one.

## How to read this guide

- **The guided path** goes from this page down into each layer, in order.
- **Features** explain one feature each: what it does, its architecture, its tables and endpoints, the functions that matter.
- **Walkthroughs** follow one action through every layer.
- **The reference** is generated from the code: [every package](/code), the [data model](/data), the [API](/api), [jobs and events](/jobs), [tools](/tools). Any function name you see links to its page, with what calls it and what it calls.
