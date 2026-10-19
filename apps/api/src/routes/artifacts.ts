import type { Artifact } from "@ofa/contracts";
import { NotFoundError, type ArtifactRecord } from "@ofa/core";
import { Hono } from "hono";
import type { Container } from "../container";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";
import { sendContent } from "../lib/content";

/**
 * Artifacts (M3.06):
 *   GET /api/artifacts/:id           what it is
 *   GET /api/artifacts/:id/content   the content: a download, or ?view=1 to show a picture or play a video (ADR-0047)
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
      const sent = await sendContent(c, found, (range) =>
        deps.artifacts.open(tenant, found.id, range),
      );
      if (!sent) throw new NotFoundError("Artifact");
      return sent;
    });
}

export function toArtifact(row: ArtifactRecord): Artifact {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
