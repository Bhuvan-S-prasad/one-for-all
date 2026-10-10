import {
  AGENT_FILE_FORMAT,
  AGENT_FILE_VERSION,
  ROUTINE_MIN_GAP_MINUTES,
  ROUTINES_PER_AGENT,
  SKILLS_PER_WORKSPACE,
  toAgentSlug,
  type AgentFile,
} from "@ofa/contracts";
import { parseCron, shortestCronGapMinutes, type TenantContext } from "@ofa/core";
import {
  createAgent,
  createRoutine,
  createSkill,
  getAgent,
  getWorkspace,
  listAgents,
  listRoutines,
  listSkills,
  updateRoutine,
  type AgentWithGrants,
  type Database,
} from "@ofa/db";

// An agent as a file (M5.12): what makes it this agent, never what it holds
// for people (sign-ins, secrets, memory, chats). Importing makes a new agent
// whose skills wait for approval and whose routines wait paused (ADR-0036):
// a file from elsewhere is outside content until a person has read it.

export async function exportAgent(
  db: Database,
  ctx: TenantContext,
  agentId: string,
): Promise<AgentFile | null> {
  const agent = await getAgent(db, ctx, agentId);
  if (!agent) return null;
  const skills = (await listSkills(db, ctx, { agentId: agent.id })).filter(
    (s) => s.agentId === agent.id && s.status === "active",
  );
  const routines = await listRoutines(db, ctx, { agentId: agent.id });
  return {
    format: AGENT_FILE_FORMAT,
    version: AGENT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    agent: {
      name: agent.name,
      slug: agent.slug,
      description: agent.description,
      spec: agent.spec,
      grants: agent.grants.map((g) => ({ tool: g.tool, mode: g.mode })),
    },
    skills: skills.map((s) => ({
      name: s.name,
      slug: s.slug,
      description: s.description,
      steps: s.steps,
    })),
    routines: routines.map((r) => ({
      name: r.name,
      instructions: r.instructions,
      kind: r.kind,
      cron: r.cron,
      timeZone: r.timeZone,
    })),
  };
}

/** `base`, else `base-2`, `base-3`… whichever is free. */
function freeSlug(base: string, taken: ReadonlySet<string>, max = 60): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface ImportResult {
  readonly agent: AgentWithGrants;
  readonly skills: number;
  readonly routines: number;
  readonly notes: string[];
}

export async function importAgent(
  db: Database,
  ctx: TenantContext,
  file: AgentFile,
): Promise<ImportResult> {
  const notes: string[] = [];
  const agentSlugs = new Set((await listAgents(db, ctx)).map((a) => a.slug));
  const wanted = file.agent.slug ?? toAgentSlug(file.agent.name);
  const slug = freeSlug(wanted, agentSlugs, 40);
  if (slug !== wanted) notes.push(`The handle @${wanted} is taken here, so it is @${slug}.`);
  const agent = await createAgent(db, ctx, { ...file.agent, slug });

  const skillSlugs = new Set((await listSkills(db, ctx)).map((s) => s.slug));
  let skills = 0;
  for (const skill of file.skills) {
    const handle = freeSlug(skill.slug, skillSlugs);
    if (handle !== skill.slug) notes.push(`The skill /${skill.slug} is /${handle} here.`);
    try {
      await createSkill(
        db,
        ctx,
        {
          agentId: agent.id,
          slug: handle,
          name: skill.name,
          description: skill.description,
          steps: skill.steps,
          // Written elsewhere: nothing follows it until a person approves it.
          status: "proposed",
          source: "person",
        },
        SKILLS_PER_WORKSPACE,
      );
      skillSlugs.add(handle);
      skills += 1;
    } catch (error) {
      notes.push(`The skill “${skill.name}” wasn't added: ${(error as Error).message}.`);
    }
  }

  const zone = (await getWorkspace(db, ctx)).timeZone;
  let routines = 0;
  for (const routine of file.routines.slice(0, ROUTINES_PER_AGENT)) {
    const timeZone = routine.timeZone ?? zone;
    const gap = shortestCronGapMinutes(parseCron(routine.cron), timeZone);
    if (gap !== null && gap < ROUTINE_MIN_GAP_MINUTES) {
      notes.push(
        `The routine “${routine.name}” runs more often than every ${ROUTINE_MIN_GAP_MINUTES} minutes, so it wasn't added.`,
      );
      continue;
    }
    const made = await createRoutine(db, ctx, {
      agentId: agent.id,
      name: routine.name,
      instructions: routine.instructions,
      kind: routine.kind,
      cron: routine.cron,
      timeZone,
      nextRunAt: null,
      limit: ROUTINES_PER_AGENT,
    });
    // Paused until a person has read it and resumes it.
    await updateRoutine(db, ctx, made.id, { status: "paused", pausedReason: "person" });
    routines += 1;
  }
  return { agent, skills, routines, notes };
}
