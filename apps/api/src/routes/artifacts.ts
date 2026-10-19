import type { Artifact } from "@ofa/contracts";
import { NotFoundError, type ArtifactRecord } from "@ofa/core";
import { Hono } from "hono";
import type { Container } from "../container";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Artifacts (M3.06):
 *   GET /api/artifacts/:id           what it is
 *   GET /api/artifacts/:id/content   the content, always as a download
 *
 * Content may come from outside (a web page, a command's output), so it is
 * never rendered by the browser on this origin: attachment, nosniff, and a
 * sandboxing CSP, whatever its type.
 */
export function artifactRoutes(deps: Pick<Container, "artifacts" | "sessions">) {
  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/:id", async (c) => {
      const found = await deps.artifacts.get(c.get("tenant"), c.req.param("id"));
      if (!found) throw new NotFoundError("Artifact");
      return c.json(toArtifact(found));
    })
    .get("/:id/content", async (c) => {
      const tenant = c.get("tenant");
      const found = await deps.artifacts.get(tenant, c.req.param("id"));
      if (!found) throw new NotFoundError("Artifact");
      const name = found.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "artifact";
      const headers = {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "accept-ranges": "bytes",
      };
      // Streamed, and by range, so a large video downloads and seeks (ADR-0047).
      const range = parseRange(c.req.header("range"), found.size);
      if (range === "invalid") {
        return c.body(null, 416, { ...headers, "content-range": `bytes */${found.size}` });
      }
      const content = await deps.artifacts.open(tenant, found.id, range ?? undefined);
      if (!content) throw new NotFoundError("Artifact");
      return c.body(ReadableStream.from(content.body), range ? 206 : 200, {
        ...headers,
        "content-length": String(content.size),
        ...(range
          ? { "content-range": `bytes ${range.start}-${range.end}/${content.totalSize}` }
          : {}),
      });
    });
}

/**
 * One range from a `Range` header (`bytes=0-99`, `bytes=100-`, `bytes=-50`),
 * clipped to the size; null for none or a form we don't serve (several
 * ranges), which gets the whole file; "invalid" for one that can't be met.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "invalid" {
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

export function toArtifact(row: ArtifactRecord): Artifact {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
