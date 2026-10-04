import { memoryListQuerySchema, type MemoryList } from "@ofa/contracts";
import { NotFoundError } from "@ofa/core";
import { confirmMemory, forgetMemory, listMemoriesForReview, recordAudit } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toMemoryItem } from "../lib/mappers";
import { requestMeta } from "../lib/request";
import { readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * What agents learned, for review (UX.14):
 *   GET    /api/memories              ?agentId=&runId=&verified=false&limit=
 *   POST   /api/memories/:id/confirm  checked by a person: agents may now use it
 *   DELETE /api/memories/:id          forget it
 *
 * A person sees workspace facts, each agent's own facts, and the notes agents
 * keep about them; never notes kept about someone else (ARCHITECTURE.md §8).
 */
export function memoryRoutes(deps: Pick<Container, "db" | "sessions">) {
  const { db } = deps;

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const query = readQuery(c, memoryListQuerySchema);
      const rows = await listMemoriesForReview(db, c.get("tenant"), query);
      return c.json({ items: rows.map(toMemoryItem) } satisfies MemoryList);
    })
    .post("/:id/confirm", async (c) => {
      const tenant = c.get("tenant");
      const row = await confirmMemory(db, tenant, c.req.param("id"));
      if (!row) throw new NotFoundError("Memory");
      // Confirming lets outside content into what agents rely on: audited.
      await recordAudit(db, tenant, {
        action: "memory.confirmed",
        targetType: "memory",
        targetId: row.id,
        ...requestMeta(c),
      });
      return c.json(toMemoryItem(row));
    })
    .delete("/:id", async (c) => {
      const tenant = c.get("tenant");
      if (!(await forgetMemory(db, tenant, c.req.param("id")))) throw new NotFoundError("Memory");
      return c.body(null, 204);
    });
}
