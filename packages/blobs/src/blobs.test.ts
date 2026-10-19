import { describe, expect, it } from "vitest";
import { createMemoryBlobStore, sweepOrphans } from "./index";

describe("blob store", () => {
  it("serves ranges and the whole size", async () => {
    const store = createMemoryBlobStore();
    const bytes = new TextEncoder().encode("hello world");
    await store.put("w/ws/a/1", bytes, { size: bytes.length, contentType: "text/plain" });
    const part = await store.get("w/ws/a/1", { start: 6, end: 10 });
    expect(part).toMatchObject({ size: 5, totalSize: 11 });
    expect(await new Response(ReadableStream.from(part!.body)).text()).toBe("world");
    expect(await store.get("w/ws/a/2")).toBeNull();
  });

  it("sweeps only old blobs that no row points at", async () => {
    let clock = new Date("2026-10-19T10:00:00Z");
    const store = createMemoryBlobStore(() => clock);
    const put = (key: string) =>
      store.put(key, new Uint8Array([1]), { size: 1, contentType: "application/octet-stream" });
    await put("w/ws/a/kept");
    await put("w/ws/a/orphan");
    clock = new Date("2026-10-19T11:30:00Z");
    await put("w/ws/a/fresh-orphan"); // its row may still be on the way
    await put("other/not-ours");

    const result = await sweepOrphans(
      store,
      async (keys) => new Set(keys.filter((k) => k.endsWith("/kept"))),
      new Date("2026-10-19T11:45:00Z"),
    );
    expect(result).toEqual({ checked: 3, removed: 1 });
    expect([...store.objects.keys()].sort()).toEqual([
      "other/not-ours",
      "w/ws/a/fresh-orphan",
      "w/ws/a/kept",
    ]);
  });
});
