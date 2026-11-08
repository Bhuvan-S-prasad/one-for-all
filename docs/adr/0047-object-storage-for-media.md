# ADR-0047: Large files go to object storage, Garage in self-host

- **Status:** Accepted
- **Date:** 2026-10-19
- **Area:** Platform
- **Related:** ADR-0042 (files back to the person), ADR-0025 (the sandbox and its egress), ADR-0022 (replaceable providers), ARCHITECTURE.md §4, §14, §15, §17

## Context

Artifacts (long tool output and files an agent sends back) live in Postgres, in a `bytea` column capped at 10 MB by a check constraint (M3.06, ADR-0042). That suits documents. The Enhancements milestone adds images and video: footage a person uploads, clips a provider generates, renders our video edit agent makes. Those run from a few MB to hundreds, and a self-hosted Postgres is the wrong place for them: it bloats backups and vacuum, and every read pulls the whole value into the app's memory.

The obvious self-hosted object store, MinIO, no longer ships its community edition: images stopped in October 2025 and the repository is archived. Measured on 2026-10-19, each in an idle container on x64, all three images also published for arm64:

| Store | Licence | Image | Idle memory | Setup |
|---|---|---:|---:|---|
| Garage v2.4.1 | AGPL-3.0 | 99 MB | 6 MiB | Cluster layout, a key and a bucket through its admin API (six HTTP calls, checked) |
| SeaweedFS 4.48 (`weed mini`) | Apache-2.0 | 724 MB | 80 MiB | Keys from the environment; buckets through S3 |
| RustFS 1.0 | Apache-2.0 | 416 MB | 109 MiB | Keys from the environment; buckets through S3; GA only since September 2026 |

The bundle targets about 3 GB of RAM on a Raspberry Pi or a free ARM VM.

## Decision

**Files over 1 MB go to an S3-compatible object store behind a `BlobStore` port; self-host runs Garage. Postgres keeps every artifact's row, and the bytes of small ones.**

- **The port.** `BlobStore` in `@ofa/core`: put bytes or a stream with a known size, get a stream (optionally a byte range), delete, list keys under a prefix. Adapters live in a new package, `packages/blobs`: S3 (any S3-compatible store: Garage, SeaweedFS, AWS S3, R2) and an in-memory store for tests. The composition root picks one; without object storage configured, the artifact store keeps everything in Postgres with today's 10 MB limit, so nothing breaks for an install that hasn't added it.
- **Which bytes move.** An artifact over 1 MB is written to the blob store under `w/<workspace>/a/<artifact id>`, and its row keeps the key instead of the bytes (`content` null, `blob_key` set; a check allows exactly one). Smaller artifacts, which are most tool output, stay in Postgres. The size limit for blob-backed artifacts is 2 GB.
- **Tenancy.** Keys carry the workspace, but the key is not the boundary: nothing reads a blob without first reading its artifact row under RLS (`withTenant`). People and agents never get a key or a URL to the store.
- **Downloads through the API.** `GET /api/artifacts/:id/content` and the agent-file route stream from the store, with the same headers as today (attachment, `nosniff`, a sandbox CSP), and honour `Range` so a video can play and seek. No pre-signed URLs: the store stays on the internal network.
- **Garage in the bundle and the dev stack.** One node, replication 1, SQLite metadata, its config in `infra/compose/garage/garage.toml` with no secrets in it; the RPC secret, admin token and S3 key come from the environment (`init-env.sh` writes them). Self-host: on the internal default network only, no published ports. Dev: S3 on `127.0.0.1:3900` and the admin API on `127.0.0.1:3903` for `pnpm dev`. The app sets Garage up on start through the admin API (layout, the key it was given, the bucket, the grant), idempotently; that code is Garage's adapter, chosen in `container.ts`.
- **The sandbox can't reach it.** Garage is not on the sandbox network, and the egress proxy refuses private addresses (ADR-0025), so an agent's computer has no path to the store.
- **Deleting.** An artifact row goes when its run or agent goes (foreign keys cascade). The hourly maintenance pass lists the store's keys and removes blobs older than an hour with no row; a blob is never read without its row, so a late sweep wastes only space.
- **S3 client.** `aws4fetch` (MIT, no dependencies) signs requests for the platform `fetch`; uploads stream with `UNSIGNED-PAYLOAD` and a known length.

## Alternatives considered

- **MinIO:** archived; we would build and patch its images ourselves.
- **SeaweedFS or RustFS:** simpler to start (no admin calls), but 13 to 18 times Garage's idle memory and four to seven times its image. Both stay usable through the S3 adapter by changing configuration.
- **Files on a Docker volume (a filesystem adapter):** no extra service at all, but no shared path once the app runs as several processes (cloud mode), and a second code path to keep. The S3 adapter covers cloud as it is.
- **Everything in Postgres with a higher limit:** the problems above, multiplied by video sizes.
- **Pre-signed URLs to the store:** the store would need a public or tailnet address, and access would no longer pass through RLS on each request.

## Consequences

- **Positive:** media of any reasonable size; Postgres stays small; one adapter serves self-host and cloud; idle cost of about 6 MiB.
- **Negative:** one more container and volume to run and back up (the backup script, M7.03, must copy the Garage volume with the database); Garage's licence is AGPL, which is fine for a separate service we don't modify or link; the app now holds Garage's admin token.
- **Follow-up:** EN.08 (port, adapters, Garage in Compose, the artifact store split, streamed and ranged downloads, the orphan sweep); EN.09 (uploads, and streaming files into and out of the agent's computer); M7.03 (backups include the store).
