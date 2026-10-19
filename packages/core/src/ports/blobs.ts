// Bytes too big for Postgres (ADR-0047): footage, generated images and
// video, renders. An S3-compatible store (Garage in self-host) behind this
// port. It knows nothing of tenants: callers read the artifact row under RLS
// first, and only that row's key ever reaches the store.
// Streams are `AsyncIterable<Uint8Array>` (a web ReadableStream is one), so
// core needs no platform types.

/** A byte range, both ends inclusive (as in an HTTP `Range` header). */
export interface BlobRange {
  readonly start: number;
  readonly end: number;
}

export interface BlobObject {
  readonly body: AsyncIterable<Uint8Array>;
  /** Bytes in `body`. */
  readonly size: number;
  /** The whole object's size, even when a range was asked for. */
  readonly totalSize: number;
}

export interface BlobStore {
  /** Make the store usable (create the bucket, or set up the server); safe to repeat. */
  ready(): Promise<void>;
  /** Store bytes under a key, replacing any there. A stream needs its exact size. */
  put(
    key: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    options: { readonly size: number; readonly contentType: string },
  ): Promise<void>;
  /** The bytes under a key, or one range of them; null if there are none. */
  get(key: string, range?: BlobRange): Promise<BlobObject | null>;
  /** Remove a key; removing one that isn't there is fine. */
  delete(key: string): Promise<void>;
  /** Keys under a prefix with when each was written, for the sweep of orphans. */
  list(prefix: string): AsyncIterable<{ readonly key: string; readonly modified: Date }>;
}

/** Where an artifact's bytes live in the store. */
export function artifactBlobKey(workspaceId: string, artifactId: string): string {
  return `w/${workspaceId}/a/${artifactId}`;
}

/** Hourly: removes blobs no artifact row points at any more (ADR-0047). */
export interface BlobSweeper {
  sweep(now: Date): Promise<{ readonly checked: number; readonly removed: number }>;
}

/** A blob younger than this is never swept: its row may still be on the way. */
export const BLOB_SWEEP_GRACE_MS = 60 * 60 * 1000;
