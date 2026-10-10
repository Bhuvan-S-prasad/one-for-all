import { SKILLS_PER_WORKSPACE, skillSlug } from "@ofa/contracts";
import type { SkillLibrary } from "@ofa/core";
import { createSkill, findUsableSkill, listSkills, type Database } from "@ofa/db";

// Skills for agents (M5.08, ADR-0036): the active ones an agent may use, and
// saving a procedure it just did. People manage skills through /api/skills.

export function createSkillLibrary(db: Database): SkillLibrary {
  return {
    async list(ctx) {
      return (await listSkills(db, ctx, { agentId: ctx.agentId, status: "active" })).map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.description,
      }));
    },

    async find(ctx, name) {
      const found = await findUsableSkill(db, ctx, ctx.agentId, name);
      return found
        ? { slug: found.slug, name: found.name, description: found.description, steps: found.steps }
        : null;
    },

    async save(ctx, input) {
      const { row } = await createSkill(
        db,
        ctx,
        {
          agentId: ctx.agentId,
          slug: skillSlug(input.name),
          name: input.name,
          description: input.description,
          steps: [...input.steps],
          // Written after outside content: it waits for a person (ADR-0013).
          status: input.tainted ? "proposed" : "active",
          source: "agent",
          sourceRunId: ctx.runId,
        },
        SKILLS_PER_WORKSPACE,
      );
      return { slug: row.slug, status: row.status === "active" ? "active" : "proposed" };
    },
  };
}
