import type { ArtifactRecord } from "@ofa/core";
import { z } from "zod";
import { defineTool, type ToolRunContext } from "../define";
import { safeDownload, type SafeDownload } from "./safe-fetch";

// Keeping files from the web (EN.13, ADR-0048): pictures, videos and
// documents an agent finds or an app makes are downloaded into the run's
// artifacts (the object store for large ones, ADR-0047), never left only at
// a provider's address, which expires. Downloads use the same guards as
// web.read_url: no private addresses, every redirect checked.

/** Largest file kept from the web. */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
/** A file whose server doesn't say its size is read into memory up to this. */
const UNSIZED_LIMIT = 64 * 1024 * 1024;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
};
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_TYPE).map(([type, ext]) => [ext, type]),
);
TYPE_BY_EXT.jpeg = "image/jpeg";
TYPE_BY_EXT.m4v = "video/mp4";

/** Links in text that look like pictures, videos or sounds by their path. */
export function mediaLinks(text: string): string[] {
  const found = text.match(/https:\/\/[^\s"'<>`\\)\]}]+/gi) ?? [];
  return [
    ...new Set(
      found
        .map((u) => u.replace(/[.,;:!?*_]+$/, ""))
        .filter((u) => {
          try {
            const ext = new URL(u).pathname.toLowerCase().split(".").pop() ?? "";
            return TYPE_BY_EXT[ext]?.match(/^(image|video|audio)\//) !== undefined;
          } catch {
            return false;
          }
        }),
    ),
  ];
}

/** A file's type: the server's, unless it is vague; else from the name. */
export function typeFor(url: string, contentType: string): string {
  if (contentType && contentType !== "application/octet-stream" && contentType.includes("/")) {
    return contentType;
  }
  const ext = new URL(url).pathname.toLowerCase().split(".").pop() ?? "";
  return TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/** A name for a downloaded file: its own, or one made from its type. */
export function nameFor(url: string, mimeType: string, fallback = "file"): string {
  const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")
    .replace(/[^\w.\- ]+/g, "_")
    .slice(0, 120);
  if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
  const ext = EXT_BY_TYPE[mimeType];
  return ext ? `${last || fallback}.${ext}` : last || fallback;
}

/** Keep a download as one of the run's files. */
export async function keepDownload(
  ctx: ToolRunContext,
  download: SafeDownload,
  options: { readonly key: string; readonly name?: string; readonly untrusted: boolean },
): Promise<ArtifactRecord> {
  if (!ctx.artifacts) {
    throw Object.assign(new Error("This server keeps no files."), { code: "not_configured" });
  }
  const mimeType = typeFor(download.url, download.contentType);
  const name = options.name ?? nameFor(download.url, mimeType);
  let content: Uint8Array | { body: AsyncIterable<Uint8Array>; size: number };
  if (download.size !== null) {
    content = { body: download.body, size: download.size };
  } else {
    const parts: Uint8Array[] = [];
    let length = 0;
    for await (const part of download.body) {
      length += part.length;
      if (length > UNSIZED_LIMIT) {
        throw Object.assign(new Error("The file is too large to keep without its size"), {
          code: "too_large",
        });
      }
      parts.push(part);
    }
    content = new Uint8Array(Buffer.concat(parts));
  }
  return ctx.artifacts.put({
    key: options.key,
    kind: "file",
    name,
    mimeType,
    content,
    untrusted: options.untrusted,
  });
}

/** web.save_file: keep a picture, video or document from the web, shown in the chat. */
export function saveFileTool(download: typeof safeDownload = safeDownload) {
  return defineTool({
    name: "web.save_file",
    description:
      "Save a file from the web (a picture, a video, a PDF) so the person sees it under your reply and it stays even if the page changes: thumbnails you are showing, images you found, a clip. Use it on the file's own address (what an <img> or a download link points to), not on a page.",
    input: z.object({
      url: z
        .url({ protocol: /^https?$/ })
        .max(2_000)
        .describe("The file's own address"),
      name: z.string().min(1).max(120).optional().describe("A name for it, with its extension"),
    }),
    // Like opening a page: it reads, and in a tainted run the address must have been given.
    annotations: { readOnly: true, idempotent: true, opensUrl: "url" },
    timeoutMs: 30 * 60_000,
    async describe({ url }) {
      return `Save ${url}`;
    },
    async run({ url, name }, ctx) {
      const got = await download(url, { maxBytes: MAX_DOWNLOAD_BYTES });
      const kept = await keepDownload(ctx, got, {
        key: `${ctx.idempotencyKey}:save`,
        ...(name ? { name: name.replace(/[/\\]+/g, "_") } : {}),
        untrusted: true,
      });
      return {
        content: `Saved ${kept.name} (${kept.mimeType}, ${kept.size.toLocaleString("en")} bytes); it shows under your reply.`,
        // The bytes came from outside, but what the model reads here is ours.
        untrusted: false,
        artifactId: kept.id,
      };
    },
  });
}
