import type { BlobObject, BlobRange, BlobStore } from "@ofa/core";

// An in-memory BlobStore for tests and for running without an object store.

export interface MemoryBlobStore extends BlobStore {
  /** What is stored, by key. */
  readonly objects: Map<string, { bytes: Uint8Array; contentType: string; modified: Date }>;
}

async function collect(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createMemoryBlobStore(now: () => Date = () => new Date()): MemoryBlobStore {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; modified: Date }>();
  return {
    objects,
    async ready() {},
    async put(key, body, { size, contentType }) {
      const bytes = await collect(body);
      if (bytes.length !== size) throw new Error(`Expected ${size} bytes, got ${bytes.length}`);
      objects.set(key, { bytes, contentType, modified: now() });
    },
    async get(key, range?: BlobRange): Promise<BlobObject | null> {
      const found = objects.get(key);
      if (!found) return null;
      const bytes = range ? found.bytes.slice(range.start, range.end + 1) : found.bytes;
      return { body: stream(bytes), size: bytes.length, totalSize: found.bytes.length };
    },
    async delete(key) {
      objects.delete(key);
    },
    async *list(prefix) {
      for (const [key, value] of objects) {
        if (key.startsWith(prefix)) yield { key, modified: value.modified };
      }
    },
  };
}
