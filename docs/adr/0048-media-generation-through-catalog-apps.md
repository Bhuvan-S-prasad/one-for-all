# ADR-0048: Media comes from catalog apps, is kept as files, and paid calls ask first under a monthly cap

- **Status:** Accepted
- **Date:** 2026-10-19
- **Area:** Integrations
- **Related:** ADR-0047 (object storage), ADR-0018 (the reviewed catalog), ADR-0028 (policy and the always-human list), ADR-0042 (files back to the person), ADR-0015 (idempotency), ARCHITECTURE.md §9.2, §9.3, §10.2

## Context

The Enhancements milestone adds pictures and video. People want an agent to make an image or a short clip, and to work on footage they send. Making media well needs hosted models that no self-hosted box can run, and the providers worth using already publish official remote MCP servers: Runway (`mcp.runwayml.com`) and Higgsfield (`mcp.higgsfield.ai`). Both sign in with OAuth and dynamic client registration, so they fit the catalog as it is.

Four things are new:

1. **Calls are slow.** A video takes one to several minutes. Both servers answer a generation with a job, and the agent checks it until it is done.
2. **Results are files at the provider's address,** and those addresses expire. Some servers send small images inline instead.
3. **Calls cost money.** Each generation uses credits the person pays for. Free-tier model limits never had a price; these do.
4. **People send media in.** Footage and images must reach the agent's computer, and files the computer makes must come back, at sizes that don't fit in a JSON body or a Postgres row.

## Decision

**Media generation is just catalog apps. The platform adds four things around them: a durable pause, keeping what they make, viewing it in the chat, and a price on every paid call with a monthly cap.**

- **Catalog apps, reviewed like the others.** `runway` and `higgsfield` are ordinary entries (`setup: automatic`, pinned `authOrigin`, narrow scopes). A new optional `media` block marks a media app: `callTimeoutSeconds` (default 600), `costPerCallUsd` and `costNote`, the basis of the estimate. We do not write our own Runway or Seedance client: the vendors' servers keep up with their models, and our code stays provider-free.
- **Long jobs: the agent polls, the platform waits durably.** A media app's calls get its longer timeout. For jobs, the agent calls the app's own status tool, and between checks it calls `wait` (5 to 600 seconds), a platform tool every agent has. After a successful `wait` the harness sleeps in an Inngest `step.sleep`, so no process is held and no model call is spent; replays skip the sleep. We considered polling inside the tool executor, but every app names its jobs and statuses differently, and a step that blocks for minutes is the wrong shape for durable runs.
- **Keeping what an app makes.** From an MCP result we keep, as the run's files (`kind: file`, untrusted): inline `image` and `audio` parts and media `resource` blobs; `resource_link` parts over https; and, for a media app, https links in its text whose path looks like media. At most eight per call, keyed `<idempotency key>:media:<n>` so a retry keeps nothing twice. Links are downloaded with the same guards as `web.read_url` (no private addresses, every redirect checked, a size limit of 1 GB), streamed into the object store for anything over 1 MB (ADR-0047). The agent's result gets one "Kept …" line per file, or why one couldn't be kept. Agents keep files from pages too, with `web.save_file`, which is read-only and, like opening a page, needs a given address in a tainted run.
- **Files in and out.** People attach files to a chat (the `upload` table; streamed into the object store; ten per message). An agent copies one into its computer with `files.receive`, only in a run of that chat and only after it was sent. `files.send` streams files of any size up to 2 GB back. The sandbox service streams both ways; the API serves files with `Range`, and inline only for allowlisted image, video and audio types under a sandbox CSP.
- **In the chat.** Pictures show in a grid and videos and sound in a player under the reply, with a full-size view and a download. A person's own attachments show the same way in their message.
- **A price on paid calls.** A media app's tools that can change something carry `costUsd`, the catalog's estimate, unless their action only looks (`get`, `list`, `status`, `check` and the like), so polling never asks. Policy holds any call with a cost for approval, whatever the grant (order 3 in §10.2), and the card says "Uses Runway credits: about $0.50 (estimate: …)".
- **A monthly cap.** Owners and admins set a limit in US dollars in Settings (`workspace.spend_cap_cents`; none by default). Before a paid call is held or run, the executor refuses it if this month's spending plus the estimate would pass the cap, so nobody approves a call that would be stopped. The estimate is written to the `spend` ledger when the call starts (once per idempotency key), because providers may charge for a job that later fails. Activity shows this month's spending per agent. The month is the UTC calendar month.

## Consequences

- Adding another media provider is a catalog entry with a `media` block, reviewed per `docs/guides/catalog-review.md`.
- Estimates are not bills. A clip's real price depends on the model, length and resolution the agent picked; the note says what the estimate assumes, and the Activity line says the app's bill is exact. A per-call estimate errs high so the cap stops early rather than late.
- A paid call always costs a click. That is deliberate: it spends someone's money.
- A provider that returns media only through a tool we don't recognise as a link (say, a JSON field with a URL to a page) leaves the file at the provider; the agent can keep it with `web.save_file`.
- `wait` is listed for every agent, including background checks, where it is harmless: it is read-only and spends nothing.
