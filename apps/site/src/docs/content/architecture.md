One-for-All is built in nine layers. Each layer has one job and only calls the layers below it, so the parts that change (a model provider, the sandbox, a channel) can be swapped without touching the rest.

## The layers

```layers
L1 Channels and clients | The web app: chat, approvals and activity, through one API | apps/web, packages/client
L2 Gateway API | Sign-in, tenancy, REST and WebSocket, approvals, OAuth callbacks; serves the web build | apps/api
L3 Orchestration | Durable runs on Inngest: lifecycle, routines, approval waits, delegation, concurrency, cancellation | packages/orchestrator
L4 Agent harness | The loop around the model: context assembly, tool dispatch, compaction, budgets, stop conditions | packages/harness
L5 Capabilities | The tool registry, MCP apps, the policy engine, credentials added only at execution | packages/tools, packages/mcp, packages/policy
L6 Model gateway | One file per provider, tiers, a shared rate-limit queue, fallback and circuit breakers | packages/llm
L7 Memory | Facts, episodes, skills, recall, consolidation | packages/memory
L8 Computer | The sandbox: a light desktop per agent, browser, shell, files, VNC | packages/sandbox, infra/docker/sandbox
L9 Data and platform | Postgres with row-level security, the vault, the event bus, telemetry, config | packages/db, vault, events, telemetry, config
```

| Layer                | Must never                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Channels and clients | Run agent logic or hold credentials                                                             |
| Gateway API          | Run the agent loop. Long work is sent as an event and the request returns at once               |
| Orchestration        | Call models or tools directly; it always goes through the harness                               |
| Agent harness        | Know which database, channel or sandbox is in use. It sees only interfaces from `packages/core` |
| Capabilities         | Put a token or password into a prompt, a log or a tool result                                   |
| Model gateway        | Bypass the queue, or pick a model outside the tier mapping                                      |
| Memory               | Accept writes that skip policy                                                                  |
| Computer             | Touch the host's files or Docker socket, or reach sites outside its allowlist                   |
| Data and platform    | Run a query without a tenant context                                                            |

## Ports and adapters

Everything that could change sits behind an interface (a _port_) in `packages/core`, and is implemented by an _adapter_. Adapters are chosen in exactly one place, the composition root `apps/api/src/container.ts`. Nothing else in the code asks which mode it is in.

| Interface         | Does                                                      | Adapter today                                     |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `LLMGateway`      | Generate; route, fall back, meter                         | OpenRouter, one provider file                     |
| `SandboxProvider` | Acquire a computer; exec, files, browser, desktop, stream | Local Docker, our own slim image                  |
| `ToolExecutor`    | List an agent's tools and run them through policy         | Built-in, MCP and sandbox tools                   |
| `PolicyEngine`    | Decide a verdict for each call                            | The rule engine                                   |
| `CredentialVault` | Get, put, rotate and redact secrets                       | AES-256-GCM envelope encryption                   |
| `MemoryStore`     | Write, recall, consolidate                                | Postgres                                          |
| `EventBus`        | Publish and subscribe                                     | Postgres `LISTEN/NOTIFY`                          |
| `StepRunner`      | Durable steps, waits, child runs                          | Inngest                                           |
| `ChatRecordStore` | Each agent's working record per chat                      | Postgres                                          |
| `TeamDirectory`   | The roster, handoffs and agent messages                   | Postgres, with capability cards from the executor |

A `TenantContext` (`workspaceId`, `userId`, and the agent and run when there is one) travels with every call, and every repository function requires it.

## The repository

```text
apps/        deployable programs: api, web, site (this site)
packages/    libraries: core, contracts, client, db, orchestrator, harness,
             llm, tools, mcp, policy, memory, sandbox, vault, events,
             telemetry, config
tooling/     shared TypeScript, ESLint and Tailwind presets
infra/       Dockerfiles, Compose files, the sandbox image, scripts
evals/       agent behaviour tested against live models
docs/        architecture, decision records, guides, the tracker
```

## Dependency rules

These are checked by lint, not by goodwill.

| Rule | Statement                                                                                   |
| ---- | ------------------------------------------------------------------------------------------- |
| R1   | Apps depend on packages. Packages never import from apps; apps never import from each other |
| R2   | `core` imports nothing internal. Every other package may import it                          |
| R3   | The web app imports only browser-safe packages: `core`, `contracts`, `client`               |
| R4   | Adapters implement a `core` interface and are chosen only in a composition root             |
| R5   | Each package exposes one public `index.ts`; deep imports are lint errors                    |
| R6   | Unit tests sit next to the code; agent behaviour is tested in `evals/`                      |
| R7   | No source code at the root; a new top-level folder needs a decision record                  |

## The stack

TypeScript everywhere, pnpm and Turborepo, a Hono API, a Vite and React web app with TanStack Router and Query, Tailwind and shadcn/ui, Postgres 17 with pgvector through Drizzle, self-hosted Inngest for durable execution, Better Auth, the AI SDK with OpenRouter, MCP, our own Docker sandbox, OpenTelemetry and zod. The [decision records](/docs/decisions) say why each was chosen and what was rejected: Next.js, Express, Prisma, Neon and BullMQ among them.
