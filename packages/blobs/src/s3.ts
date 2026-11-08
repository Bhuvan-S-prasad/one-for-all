import type { BlobObject, BlobRange, BlobStore } from "@ofa/core";
import { AwsClient } from "aws4fetch";

// Any S3-compatible store (ADR-0047): Garage in self-host, S3 or R2 in the
// cloud. Path-style requests (`<endpoint>/<bucket>/<key>`), signed with
// SigV4 by aws4fetch; uploads stream with an unsigned payload and a known
// length. Only the few calls the port needs.

export interface S3BlobStoreOptions {
  /** `http://127.0.0.1:3900`, `http://garage:3900`, `https://s3.eu-west-1.amazonaws.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** For tests. */
  readonly fetch?: typeof fetch;
}

export class BlobStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Keys are ours (`w/<workspace>/a/<id>`): letters, digits and `/._-` only. */
function checkKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9/._-]{0,1023}$/.test(key) || key.includes("..")) {
    throw new BlobStoreError(`Not a blob key: ${key}`, 400);
  }
  return key;
}

export function createS3BlobStore(options: S3BlobStoreOptions): BlobStore {
  const doFetch = options.fetch ?? globalThis.fetch;
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: options.region,
    retries: 0,
  });
  const base = options.endpoint.replace(/\/+$/, "");
  const bucketUrl = `${base}/${encodeURIComponent(options.bucket)}`;
  const objectUrl = (key: string) =>
    `${bucketUrl}/${checkKey(key).split("/").map(encodeURIComponent).join("/")}`;

  const send = async (url: string, init: RequestInit & { duplex?: "half" } = {}) =>
    doFetch(await client.sign(url, init));

  const fail = async (what: string, response: Response): Promise<never> => {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new BlobStoreError(`${what}: HTTP ${response.status} ${detail}`.trim(), response.status);
  };

  return {
    async ready() {
      const head = await send(bucketUrl, { method: "HEAD" });
      if (head.ok) return;
      if (head.status !== 404) return fail("Object store unreachable", head);
      const created = await send(bucketUrl, { method: "PUT" });
      // Another process may have made it a moment ago.
      if (!created.ok && created.status !== 409) await fail("Creating the bucket", created);
    },

    async put(key, body, { size, contentType }) {
      const response = await send(objectUrl(key), {
        method: "PUT",
        body: body instanceof Uint8Array ? body : ReadableStream.from(body),
        headers: { "content-type": contentType, "content-length": String(size) },
        ...(body instanceof Uint8Array ? {} : { duplex: "half" as const }),
      });
      if (!response.ok) await fail(`Storing ${key}`, response);
      await response.body?.cancel();
    },

    async get(key, range?: BlobRange): Promise<BlobObject | null> {
      const response = await send(objectUrl(key), {
        method: "GET",
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {}),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || !response.body) return fail(`Reading ${key}`, response);
      const size = Number(response.headers.get("content-length") ?? 0);
      // `Content-Range: bytes 0-99/1234` carries the whole size for a range.
      const total = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1];
      return { body: response.body, size, totalSize: total ? Number(total) : size };
    },

    async delete(key) {
      const response = await send(objectUrl(key), { method: "DELETE" });
      if (!response.ok && response.status !== 404) await fail(`Deleting ${key}`, response);
      await response.body?.cancel();
    },

    async *list(prefix) {
      let token: string | undefined;
      do {
        const url = new URL(bucketUrl);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const response = await send(url.toString(), { method: "GET" });
        if (!response.ok) await fail("Listing the bucket", response);
        const xml = await response.text();
        for (const entry of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const body = entry[1] ?? "";
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
          const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(body)?.[1];
          if (key) yield { key: unescapeXml(key), modified: new Date(modified ?? 0) };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? unescapeXml(
              /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "",
            )
          : undefined;
      } while (token);
    },
  };
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
