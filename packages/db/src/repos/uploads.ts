import { randomUUID } from "node:crypto";
import {
  BLOB_THRESHOLD_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_BLOB_ARTIFACT_BYTES,
  uploadBlobKey,
  type BlobObject,
  type BlobRange,
  type BlobStore,
  type TenantContext,
} from "@ofa/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../client";
import { upload } from "../schema/index";
import { withTenant } from "../tenant";

// Files people attach to a chat (EN.09). Kept like artifacts (ADR-0047):
// small ones in Postgres, larger ones in the object store. Only the person
// who uploaded one can send it, and only in its own chat.

export interface UploadRow {
  readonly id: string;
  readonly threadId: string;
  readonly uploadedBy: string | null;
  readonly messageId: string | null;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: Date;
}

const columns = {
  id: upload.id,
  threadId: upload.threadId,
  uploadedBy: upload.uploadedBy,
  messageId: upload.messageId,
  name: upload.name,
  mimeType: upload.mimeType,
  size: upload.size,
  createdAt: upload.createdAt,
};

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

const tooLarge = (limit: string) =>
  Object.assign(new Error(`Too large to keep (over ${limit})`), { code: "too_large" });

async function collect(body: Uint8Array | AsyncIterable<Uint8Array>, size: number) {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of body) {
    length += part.length;
    if (length > size) throw Object.assign(new Error("More bytes than announced"), { code: "bad_request" });
    parts.push(part);
  }
  if (length !== size) {
    throw Object.assign(new Error("The upload ended early"), { code: "bad_request" });
  }
  return Buffer.concat(parts);
}

/** Store a file a person attached, before the message it goes with is sent. */
export async function createUpload(
  db: Database,
  blobs: BlobStore | null,
  ctx: TenantContext,
  input: {
    readonly threadId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly size: number;
    readonly body: Uint8Array | AsyncIterable<Uint8Array>;
  },
): Promise<UploadRow> {
  const toBlob = !!blobs && input.size > BLOB_THRESHOLD_BYTES;
  if (!toBlob && input.size > MAX_ARTIFACT_BYTES) throw tooLarge("10 MB");
  if (input.size > MAX_BLOB_ARTIFACT_BYTES) throw tooLarge("2 GB");
  const id = randomUUID();
  const blobKey = toBlob ? uploadBlobKey(ctx.workspaceId, id) : null;
  let content: Buffer | null = null;
  if (blobs && blobKey) {
    await blobs.put(blobKey, input.body, { size: input.size, contentType: input.mimeType });
  } else {
    content = await collect(input.body, input.size);
  }
  return withTenant(db, ctx, async (tx) => {
    const [row] = await tx
      .insert(upload)
      .values({
        id,
        workspaceId: ctx.workspaceId,
        threadId: input.threadId,
        uploadedBy: ctx.userId,
        name: input.name.slice(0, 255),
        mimeType: input.mimeType,
        size: input.size,
        content,
        blobKey,
      })
      .returning(columns);
    if (!row) throw new Error("upload insert returned no row");
    return row;
  });
}

export async function getUpload(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<UploadRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select(columns).from(upload).where(eq(upload.id, id)).limit(1),
  );
  return row ?? null;
}

/** An upload's bytes, or one range of them, after its row is read under RLS. */
export async function openUpload(
  db: Database,
  blobs: BlobStore | null,
  ctx: TenantContext,
  id: string,
  range?: BlobRange,
): Promise<BlobObject | null> {
  if (!isUuid(id)) return null;
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .select({ content: upload.content, blobKey: upload.blobKey })
      .from(upload)
      .where(eq(upload.id, id))
      .limit(1),
  );
  if (!row) return null;
  if (row.content) {
    const all = new Uint8Array(row.content);
    const bytes = range ? all.slice(range.start, range.end + 1) : all;
    const body = (async function* () {
      yield bytes;
    })();
    return { body, size: bytes.length, totalSize: all.length };
  }
  return row.blobKey && blobs ? blobs.get(row.blobKey, range) : null;
}

/**
 * Tie uploads to the message they were sent with. Only the sender's own,
 * not yet sent, from this chat: anything else is left out.
 */
export async function attachUploads(
  db: Database,
  ctx: TenantContext,
  input: { readonly threadId: string; readonly messageId: string; readonly ids: readonly string[] },
): Promise<UploadRow[]> {
  const ids = input.ids.filter(isUuid);
  if (ids.length === 0) return [];
  return withTenant(db, ctx, (tx) =>
    tx
      .update(upload)
      .set({ messageId: input.messageId })
      .where(
        and(
          inArray(upload.id, ids),
          eq(upload.threadId, input.threadId),
          eq(upload.uploadedBy, ctx.userId),
          isNull(upload.messageId),
        ),
      )
      .returning(columns),
  );
}

/** The line a sent upload adds to its message, which agents and the chat both read. */
export function attachmentLine(row: Pick<UploadRow, "id" | "name" | "mimeType" | "size">): string {
  const name = row.name.replace(/[\]\n\r·]/g, " ").trim() || "file";
  return `[Attached: ${name} · ${row.mimeType} · ${formatBytes(row.size)} · upload://${row.id}]`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

/** The sender's own uploads in this chat not yet sent, of these IDs, in the given order. */
export async function sendableUploads(
  db: Database,
  ctx: TenantContext,
  input: { readonly threadId: string; readonly ids: readonly string[] },
): Promise<UploadRow[]> {
  const ids = input.ids.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await withTenant(db, ctx, (tx) =>
    tx
      .select(columns)
      .from(upload)
      .where(
        and(
          inArray(upload.id, ids),
          eq(upload.threadId, input.threadId),
          eq(upload.uploadedBy, ctx.userId),
          isNull(upload.messageId),
        ),
      ),
  );
  return ids.flatMap((id) => rows.filter((r) => r.id === id));
}
