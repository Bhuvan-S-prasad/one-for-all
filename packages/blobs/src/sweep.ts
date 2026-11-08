import { BLOB_SWEEP_GRACE_MS, type BlobStore } from "@ofa/core";

// The orphan sweep (ADR-0047). An artifact row goes when its run or agent
// goes; its blob stays behind until this finds it: under `w/`, older than an
// hour, and pointed at by no row. A blob is never read without its row, so
// a blob waiting here costs only space.

const BATCH = 500;

export async function sweepOrphans(
  store: BlobStore,
  /** Of these keys, the ones an artifact row still points at. */
  referenced: (keys: readonly string[]) => Promise<Set<string>>,
  now: Date,
): Promise<{ checked: number; removed: number }> {
  const cutoff = now.getTime() - BLOB_SWEEP_GRACE_MS;
  let checked = 0;
  let removed = 0;
  let batch: string[] = [];
  const flush = async () => {
    const kept = await referenced(batch);
    for (const key of batch) {
      if (kept.has(key)) continue;
      await store.delete(key);
      removed += 1;
    }
    batch = [];
  };
  for await (const item of store.list("w/")) {
    checked += 1;
    if (item.modified.getTime() > cutoff) continue;
    batch.push(item.key);
    if (batch.length >= BATCH) await flush();
  }
  if (batch.length > 0) await flush();
  return { checked, removed };
}
