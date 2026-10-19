import type { AgentId, ArtifactId, RunId } from "../ids";
import type { RunContext, TenantContext } from "../tenant";
import type { BlobObject, BlobRange } from "./blobs";

// What runs produce (M3.06, ARCHITECTURE.md §7): long tool output kept out of
// the context and reopened by handle, and files agents wrote, for people to
// open from the chat. Postgres in self-host; object storage can sit behind
// the same port.

export const ARTIFACT_KINDS = ["output", "file"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Largest artifact kept in Postgres, and read whole into memory: 10 MB. */
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/** Content over this goes to the object store when one is set up (ADR-0047). */
export const BLOB_THRESHOLD_BYTES = 1024 * 1024;

/** Largest artifact kept in the object store: 2 GB. */
export const MAX_BLOB_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024 - 1;

export interface ArtifactRecord {
  readonly id: ArtifactId;
  readonly runId: RunId;
  readonly agentId: AgentId;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly untrusted: boolean;
  readonly createdAt: Date;
}

export interface ArtifactInput {
  /** Unique within the run, from the tool call's idempotency key, so a retry finds it. */
  readonly key: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly mimeType: string;
  readonly content: Uint8Array | string;
  readonly untrusted: boolean;
}

export interface ArtifactStore {
  /** Store an artifact for the run in `ctx`; the same key returns the one already stored. */
  put(ctx: RunContext, input: ArtifactInput): Promise<ArtifactRecord>;
  get(ctx: TenantContext, id: string): Promise<ArtifactRecord | null>;
  /** The whole content in memory; refuses (code `too_large`) over MAX_ARTIFACT_BYTES. */
  read(ctx: TenantContext, id: string): Promise<Uint8Array | null>;
  /** The content as a stream, or one byte range of it, for downloads and playback. */
  open(ctx: TenantContext, id: string, range?: BlobRange): Promise<BlobObject | null>;
  listForRun(ctx: TenantContext, runId: string): Promise<ArtifactRecord[]>;
}

/** `artifact://<id>`, the handle agents see. */
export function artifactUri(id: string): string {
  return `artifact://${id}`;
}

/** The ID in `artifact://<id>` (or a bare ID), or null. */
export function parseArtifactUri(value: string): string | null {
  const id = value.trim().replace(/^artifact:\/\//, "");
  return /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
}
