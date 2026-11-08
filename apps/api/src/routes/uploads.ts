import { NotFoundError } from "@ofa/core";
import { getUpload, openUpload } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toUpload } from "../lib/mappers";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";
import { sendContent } from "../lib/content";

/**
 * Files people attached to a chat (EN.09):
 *   GET /api/uploads/:id           what it is
 *   GET /api/uploads/:id/content   the bytes, by range: a download, or ?view=1 for pictures, video and sound
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
      const found = await getUpload(deps.db, c.get("tenant"), c.req.param("id"));
      if (!found) throw new NotFoundError("File");
      const sent = await sendContent(c, found, (range) =>
        openUpload(deps.db, deps.blobs, tenant, found.id, range),
      );
      if (!sent) throw new NotFoundError("File");
      return sent;
    });
}
