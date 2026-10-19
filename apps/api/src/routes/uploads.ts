import { NotFoundError } from "@ofa/core";
import { getUpload, openUpload } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toUpload } from "../lib/mappers";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";
import { parseRange } from "./artifacts";

/**
 * Files people attached to a chat (EN.09):
 *   GET /api/uploads/:id           what it is
 *   GET /api/uploads/:id/content   the bytes, as a download, by range (ADR-0047)
 *
 * Served like artifacts: never rendered on this origin (attachment,
 * nosniff, a sandboxing CSP).
 */
export function uploadRoutes(deps: Pick<Container, "db" | "blobs" | "sessions">) {
  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/:id", async (c) => {
      const found = await getUpload(deps.db, c.get("tenant"), c.req.param("id"));
      if (!found) throw new NotFoundError("File");
      return c.json(toUpload(found));
    })
    .get("/:id/content", async (c) => {
      const tenant = c.get("tenant");
      const found = await getUpload(deps.db, tenant, c.req.param("id"));
      if (!found) throw new NotFoundError("File");
      const name = found.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
      const headers = {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "accept-ranges": "bytes",
      };
      const range = parseRange(c.req.header("range"), found.size);
      if (range === "invalid") {
        return c.body(null, 416, { ...headers, "content-range": `bytes */${found.size}` });
      }
      const content = await openUpload(deps.db, deps.blobs, tenant, found.id, range ?? undefined);
      if (!content) throw new NotFoundError("File");
      return c.body(ReadableStream.from(content.body), range ? 206 : 200, {
        ...headers,
        "content-length": String(content.size),
        ...(range
          ? { "content-range": `bytes ${range.start}-${range.end}/${content.totalSize}` }
          : {}),
      });
    });
}
