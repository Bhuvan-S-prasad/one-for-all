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
      const content = found ? await deps.artifacts.read(tenant, found.id) : null;
      if (!found || !content) throw new NotFoundError("Artifact");
      const name = found.name.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "artifact";
      return c.body(Buffer.from(content), 200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
      });
    });
}

export function toArtifact(row: ArtifactRecord): Artifact {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
