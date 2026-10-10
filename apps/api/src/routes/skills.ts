import {
  createSkillRequestSchema,
  SKILLS_PER_WORKSPACE,
  skillListQuerySchema,
  skillSlug,
  updateSkillRequestSchema,
  type SkillList,
} from "@ofa/contracts";
import { NotFoundError } from "@ofa/core";
import { createSkill, deleteSkill, getAgent, getSkill, listSkills, updateSkill } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toSkill } from "../lib/mappers";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Skills (M5.08, ADR-0036):
 *   GET    /api/skills          all, or one agent's with the shared ones (?agentId=&status=)
 *   POST   /api/skills          a person's skill: active at once
 *   GET    /api/skills/:id
 *   PATCH  /api/skills/:id      edit; `status: active` approves a proposed one
 *   DELETE /api/skills/:id
 *
 * Agents save their own with `save_skill`, and nightly consolidation proposes
 * some; only active skills reach a model.
 */
export function skillRoutes(deps: Pick<Container, "db" | "sessions">) {
  const { db } = deps;

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const query = readQuery(c, skillListQuerySchema);
      const rows = await listSkills(db, c.get("tenant"), query);
      return c.json({ items: rows.map(toSkill) } satisfies SkillList);
    })
    .post("/", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, createSkillRequestSchema);
      if (input.agentId) {
        const agent = await getAgent(db, tenant, input.agentId);
        if (!agent) throw new NotFoundError("Agent");
      }
      const { row } = await createSkill(
        db,
        tenant,
        {
          agentId: input.agentId ?? null,
          slug: input.slug ?? skillSlug(input.name),
          name: input.name,
          description: input.description,
          steps: input.steps,
          status: "active",
          source: "person",
        },
        SKILLS_PER_WORKSPACE,
      );
      return c.json(toSkill(row), 201);
    })
    .get("/:id", async (c) => {
      const row = await getSkill(db, c.get("tenant"), c.req.param("id"));
      if (!row) throw new NotFoundError("Skill");
      return c.json(toSkill(row));
    })
    .patch("/:id", async (c) => {
      const patch = await readJson(c, updateSkillRequestSchema);
      const row = await updateSkill(db, c.get("tenant"), c.req.param("id"), patch);
      if (!row) throw new NotFoundError("Skill");
      return c.json(toSkill(row));
    })
    .delete("/:id", async (c) => {
      const deleted = await deleteSkill(db, c.get("tenant"), c.req.param("id"));
      if (!deleted) throw new NotFoundError("Skill");
      return c.body(null, 204);
    });
}
