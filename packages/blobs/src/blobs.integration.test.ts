import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createS3BlobStore, setUpGarage } from "./index";

// Against the dev stack's Garage (`pnpm infra:up`), with its dev defaults.

const adminUrl = process.env.GARAGE_ADMIN_URL ?? "http://127.0.0.1:3903";
const adminToken = process.env.GARAGE_ADMIN_TOKEN ?? "ofa-garage-dev-admin-token";
const key = { accessKeyId: "GK0f1a2b3c4d5e6f7a8b9c0d1e", secretAccessKey: "5".repeat(64) };
const bucket = `ofa-test-${randomUUID().slice(0, 8)}`;
const store = createS3BlobStore({
  endpoint: process.env.BLOB_S3_ENDPOINT ?? "http://127.0.0.1:3900",
  bucket,
  region: "garage",
  ...key,
});

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  return new Response(ReadableStream.from(body)).text();
}

describe("Garage object store (integration)", () => {
  beforeAll(async () => {
    await setUpGarage({ adminUrl, adminToken, bucket, ...key });
    // Running it again changes nothing and fails on nothing.
    await setUpGarage({ adminUrl, adminToken, bucket, ...key });
    await store.ready();
  });

  it("stores bytes, reads them whole or by range, lists and deletes them", async () => {
    const id = `w/ws-1/a/${randomUUID()}`;
    const bytes = new TextEncoder().encode("0123456789".repeat(100));
    await store.put(id, bytes, { size: bytes.length, contentType: "text/plain" });

    const whole = await store.get(id);
    expect(whole?.size).toBe(1000);
    expect(await text(whole!.body)).toBe("0123456789".repeat(100));

    const part = await store.get(id, { start: 10, end: 14 });
    expect(part).toMatchObject({ size: 5, totalSize: 1000 });
    expect(await text(part!.body)).toBe("01234");

    const listed: string[] = [];
    for await (const item of store.list("w/ws-1/")) listed.push(item.key);
    expect(listed).toContain(id);

    await store.delete(id);
    expect(await store.get(id)).toBeNull();
    await store.delete(id); // already gone: fine
  });

  it("streams a large upload without holding it in memory first", async () => {
    const id = `w/ws-1/a/${randomUUID()}`;
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 8) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    await store.put(id, body, { size: 8 * chunk.length, contentType: "video/mp4" });
    const got = await store.get(id, { start: 8 * chunk.length - 4, end: 8 * chunk.length - 1 });
    expect(got).toMatchObject({ size: 4, totalSize: 8 * chunk.length });
    expect([
      ...new Uint8Array(await new Response(ReadableStream.from(got!.body)).arrayBuffer()),
    ]).toEqual([7, 7, 7, 7]);
    await store.delete(id);
  });

  it("refuses keys that aren't ours", async () => {
    await expect(store.get("../escape")).rejects.toThrow(/Not a blob key/);
    await expect(store.get("w/a/../../x")).rejects.toThrow(/Not a blob key/);
  });
});
