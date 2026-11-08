import { randomUUID } from "node:crypto";
import {
  artifactBlobKey,
  asId,
  BLOB_THRESHOLD_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_BLOB_ARTIFACT_BYTES,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactStore,
  type BlobObject,
  type BlobStore,
  type TenantContext,
} from "@ofa/core";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "../client";
import { artifact, upload } from "../schema/index";
import { withTenant } from "../tenant";

// The artifact store (M3.06). Small content lives in a bytea column; with an
// object store (ADR-0047), content over 1 MB goes there and the row keeps its
// key. Without one, everything stays in Postgres, up to 10 MB.

const columns = {
  id: artifact.id,
  runId: artifact.runId,
  agentId: artifact.agentId,
  kind: artifact.kind,
  name: artifact.name,
  mimeType: artifact.mimeType,
  size: artifact.size,
  untrusted: artifact.untrusted,
  createdAt: artifact.createdAt,
};

type Row = { [K in keyof typeof columns]: (typeof artifact.$inferSelect)[K] };

function toRecord(row: Row): ArtifactRecord {
  return {
    ...row,
    id: asId(row.id),
    runId: asId(row.runId),
    agentId: asId(row.agentId),
    kind: row.kind as ArtifactKind,
  };
}

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

const tooLarge = (limit: string) =>
  Object.assign(new Error(`Too large to keep (over ${limit})`), { code: "too_large" });

/** A stream's bytes, which must be exactly `size` of them. */
async function collectExactly(body: AsyncIterable<Uint8Array>, size: number): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of body) {
    length += part.length;
    if (length > size) throw new Error("More bytes than announced");
    parts.push(part);
  }
  if (length !== size) throw new Error("The file ended early");
  return Buffer.concat(parts);
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createArtifactStore(db: Database, blobs?: BlobStore | null): ArtifactStore {
  /** The row's content or blob key, under the caller's tenant (RLS). */
  const locate = async (ctx: TenantContext, id: string) => {
    if (!isUuid(id)) return null;
    const [row] = await withTenant(db, ctx, (tx) =>
      tx
        .select({ content: artifact.content, blobKey: artifact.blobKey, size: artifact.size })
        .from(artifact)
        .where(eq(artifact.id, id))
        .limit(1),
    );
    return row ?? null;
  };

  return {
    async put(ctx, input) {
      const streamed =
        typeof input.content === "object" && "body" in input.content ? input.content : null;
      const size = streamed
        ? streamed.size
        : Buffer.byteLength(input.content as Uint8Array | string);
      const toBlob = !!blobs && size > BLOB_THRESHOLD_BYTES;
      if (!toBlob && size > MAX_ARTIFACT_BYTES) throw tooLarge("10 MB");
      if (size > MAX_BLOB_ARTIFACT_BYTES) throw tooLarge("2 GB");
      const id = randomUUID();
      const blobKey = toBlob ? artifactBlobKey(ctx.workspaceId, id) : null;
      // The bytes first: a row never points at a blob that isn't there. If the
      // row then loses to a retried step's, the extra blob is swept later.
      let content: Buffer | null = null;
      if (blobs && blobKey) {
        await blobs.put(
          blobKey,
          streamed
            ? streamed.body
            : new Uint8Array(Buffer.from(input.content as Uint8Array | string)),
          { size, contentType: input.mimeType },
        );
      } else {
        content = streamed
          ? await collectExactly(streamed.body, size)
          : Buffer.from(input.content as Uint8Array | string);
      }
      return withTenant(db, ctx, async (tx) => {
        const [created] = await tx
          .insert(artifact)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            runId: ctx.runId,
            agentId: ctx.agentId,
            key: input.key,
            kind: input.kind,
            name: input.name.slice(0, 500),
            mimeType: input.mimeType,
            size,
            untrusted: input.untrusted,
            content,
            blobKey,
          })
          .onConflictDoNothing({ target: [artifact.runId, artifact.key] })
          .returning(columns);
        if (created) return toRecord(created);
        // A retried step: the artifact from the first attempt.
        const [existing] = await tx
          .select(columns)
          .from(artifact)
          .where(and(eq(artifact.runId, ctx.runId), eq(artifact.key, input.key)))
          .limit(1);
        if (!existing) throw new Error("artifact vanished");
        return toRecord(existing);
      });
    },

    async get(ctx: TenantContext, id: string) {
      if (!isUuid(id)) return null;
      const [row] = await withTenant(db, ctx, (tx) =>
        tx.select(columns).from(artifact).where(eq(artifact.id, id)).limit(1),
      );
      return row ? toRecord(row) : null;
    },

    async read(ctx: TenantContext, id: string) {
      const row = await locate(ctx, id);
      if (!row) return null;
      if (row.content) return new Uint8Array(row.content);
      if (row.size > MAX_ARTIFACT_BYTES) throw tooLarge("10 MB to read at once");
      const found = row.blobKey && blobs ? await blobs.get(row.blobKey) : null;
      if (!found) return null;
      const parts: Uint8Array[] = [];
      for await (const part of found.body) parts.push(part);
      return new Uint8Array(Buffer.concat(parts));
    },

    async open(ctx: TenantContext, id: string, range): Promise<BlobObject | null> {
      const row = await locate(ctx, id);
      if (!row) return null;
      if (row.content) {
        const all = new Uint8Array(row.content);
        const bytes = range ? all.slice(range.start, range.end + 1) : all;
        return { body: bytesStream(bytes), size: bytes.length, totalSize: all.length };
      }
      return row.blobKey && blobs ? blobs.get(row.blobKey, range) : null;
    },

    async listForRun(ctx: TenantContext, runId: string) {
      if (!isUuid(runId)) return [];
      const rows = await withTenant(db, ctx, (tx) =>
        tx
          .select(columns)
          .from(artifact)
          .where(eq(artifact.runId, runId))
          .orderBy(asc(artifact.createdAt)),
      );
      return rows.map(toRecord);
    },
  };
}

/**
 * Of the given object-store keys, those an artifact or an upload still points
 * at (owner connection: the sweep looks across workspaces, ADR-0047).
 */
export async function referencedBlobKeys(
  ownerDb: Database,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const list = [...keys];
  const [artifacts, uploads] = await Promise.all([
    ownerDb
      .select({ key: artifact.blobKey })
      .from(artifact)
      .where(and(isNotNull(artifact.blobKey), inArray(artifact.blobKey, list))),
    ownerDb
      .select({ key: upload.blobKey })
      .from(upload)
      .where(and(isNotNull(upload.blobKey), inArray(upload.blobKey, list))),
  ]);
  return new Set([...artifacts, ...uploads].flatMap((r) => (r.key ? [r.key] : [])));
}
