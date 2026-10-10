import { AppError, type TenantContext } from "@ofa/core";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { skill } from "../schema/index";
import { withTenant } from "../tenant";

// Skills (M5.08, ADR-0036): procedural memory, instructions only. A person
// sees and edits them all; an agent uses the active ones that are its own or
// shared (no agent).

export type SkillRow = typeof skill.$inferSelect;
type SkillStatus = SkillRow["status"];

/** Its own and the shared ones. */
function usableBy(agentId: string) {
  return or(eq(skill.agentId, agentId), isNull(skill.agentId))!;
}

export async function listSkills(
  db: Database,
  ctx: TenantContext,
  options: { agentId?: string; status?: SkillStatus } = {},
): Promise<SkillRow[]> {
  return withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(skill)
      .where(
        and(
          options.agentId ? usableBy(options.agentId) : undefined,
          options.status ? eq(skill.status, options.status) : undefined,
        ),
      )
      .orderBy(asc(skill.name))
      .limit(500),
  );
}

export async function getSkill(
  db: Database,
  ctx: TenantContext,
  id: string,
): Promise<SkillRow | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.select().from(skill).where(eq(skill.id, id)).limit(1),
  );
  return row ?? null;
}

/** An active skill the agent may use, by handle or name (any case). */
export async function findUsableSkill(
  db: Database,
  ctx: TenantContext,
  agentId: string,
  name: string,
): Promise<SkillRow | null> {
  const wanted = name.trim().replace(/^\//, "").toLowerCase();
  const [row] = await withTenant(db, ctx, (tx) =>
    tx
      .select()
      .from(skill)
      .where(
        and(
          usableBy(agentId),
          eq(skill.status, "active"),
          or(eq(skill.slug, wanted), sql`lower(${skill.name}) = ${wanted}`),
        ),
      )
      // The agent's own before a shared one of the same name.
      .orderBy(sql`${skill.agentId} is null`)
      .limit(1),
  );
  return row ?? null;
}

export type SkillInsert = Pick<
  SkillRow,
  "slug" | "name" | "description" | "steps" | "status" | "source"
> & {
  agentId: string | null;
  sourceRunId?: string | null;
};

/**
 * A new skill. A handle already in use is refused (`conflict`), except that
 * an agent saving its own skill again replaces it. At most `limit` per
 * workspace.
 */
export async function createSkill(
  db: Database,
  ctx: TenantContext,
  input: SkillInsert,
  limit: number,
): Promise<{ row: SkillRow; created: boolean }> {
  return withTenant(db, ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skill:${ctx.workspaceId}`}))`);
    const [existing] = await tx.select().from(skill).where(eq(skill.slug, input.slug)).limit(1);
    if (existing) {
      const ownAgain =
        input.source === "agent" &&
        existing.source === "agent" &&
        existing.agentId === input.agentId &&
        existing.status !== "archived";
      if (!ownAgain) {
        throw new AppError("conflict", `A skill called /${input.slug} already exists`);
      }
      const [row] = await tx
        .update(skill)
        .set({
          name: input.name,
          description: input.description,
          steps: input.steps,
          // A tainted re-save can't keep a skill active without a person.
          status: existing.status === "proposed" ? "proposed" : input.status,
          sourceRunId: input.sourceRunId ?? existing.sourceRunId,
        })
        .where(eq(skill.id, existing.id))
        .returning();
      return { row: row!, created: false };
    }
    const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(skill);
    if ((counted?.n ?? 0) >= limit) {
      throw new AppError("conflict", `A workspace can have at most ${limit} skills`);
    }
    const [row] = await tx
      .insert(skill)
      .values({
        workspaceId: ctx.workspaceId,
        ...input,
        sourceRunId: input.sourceRunId ?? null,
        createdBy: input.source === "person" ? ctx.userId : null,
      })
      .returning();
    if (!row) throw new Error("skill insert returned no row");
    return { row, created: true };
  });
}

export async function updateSkill(
  db: Database,
  ctx: TenantContext,
  id: string,
  patch: Partial<Pick<SkillRow, "name" | "description" | "steps" | "status">>,
): Promise<SkillRow | null> {
  const [row] = await withTenant(db, ctx, (tx) =>
    tx.update(skill).set(patch).where(eq(skill.id, id)).returning(),
  );
  return row ?? null;
}

export async function deleteSkill(db: Database, ctx: TenantContext, id: string): Promise<boolean> {
  const rows = await withTenant(db, ctx, (tx) =>
    tx.delete(skill).where(eq(skill.id, id)).returning({ id: skill.id }),
  );
  return rows.length > 0;
}
