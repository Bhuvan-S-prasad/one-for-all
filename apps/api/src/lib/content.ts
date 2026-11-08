import type { BlobObject, BlobRange } from "@ofa/core";
import type { Context } from "hono";

// Serving stored bytes (artifacts and uploads, ADR-0047): streamed, by range
// so a video downloads and seeks. Content may come from outside, so it is
// never rendered on this origin as a page: a download by default, nosniff
// and a sandboxing CSP always. `?view=1` lets the browser show a picture or
// play a video or sound in place; only these types, which can't run script.

const VIEWABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
]);

export function isViewable(mimeType: string): boolean {
  return VIEWABLE.has(mimeType);
}

/**
 * One range from a `Range` header (`bytes=0-99`, `bytes=100-`, `bytes=-50`),
 * clipped to the size; null for none or a form we don't serve (several
 * ranges), which gets the whole file; "invalid" for one that can't be met.
 */
export function parseRange(header: string | undefined, size: number): BlobRange | null | "invalid" {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  if (size === 0) return "invalid";
  if (from === "") {
    const last = Math.min(Number(to), size);
    return last > 0 ? { start: size - last, end: size - 1 } : "invalid";
  }
  const start = Number(from);
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  return start < size && start <= end ? { start, end } : "invalid";
}

export async function sendContent(
  c: Context,
  file: { readonly name: string; readonly mimeType: string; readonly size: number },
  open: (range?: BlobRange) => Promise<BlobObject | null>,
): Promise<Response | null> {
  const name = file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
  const view = c.req.query("view") === "1" && isViewable(file.mimeType);
  const headers = {
    "content-type": view ? file.mimeType : "application/octet-stream",
    "content-disposition": `${view ? "inline" : "attachment"}; filename="${name}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "accept-ranges": "bytes",
  };
  const range = parseRange(c.req.header("range"), file.size);
  if (range === "invalid") {
    return c.body(null, 416, { ...headers, "content-range": `bytes */${file.size}` });
  }
  const content = await open(range ?? undefined);
  if (!content) return null;
  return c.body(ReadableStream.from(content.body), range ? 206 : 200, {
    ...headers,
    "content-length": String(content.size),
    ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${content.totalSize}` } : {}),
  });
}
