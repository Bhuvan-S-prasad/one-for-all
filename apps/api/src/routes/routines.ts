import {
  createRoutineRequestSchema,
  ROUTINE_HISTORY_RUNS,
  ROUTINE_MIN_GAP_MINUTES,
  ROUTINES_PER_AGENT,
  routineListQuerySchema,
  updateRoutineRequestSchema,
  type RoutineList,
  type RoutineRuns,
} from "@ofa/contracts";
import {
  AppError,
  asId,
  nextCronTime,
  NotFoundError,
  parseCron,
  shortestCronGapMinutes,
  type RunId,
} from "@ofa/core";
import {
  createRoutine,
  deleteRoutine,
  getAgent,
  getRoutine,
  getRun,
  getWorkspace,
  listRoutineRuns,
  listRoutines,
  updateRoutine,
  type RoutineRow,
} from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toRoutine, toRun } from "../lib/mappers";
import { readJson, readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * Routines (M5.06, ADR-0035):
 *   GET    /api/routines              all, or one agent's (?agentId=)
 *   POST   /api/routines              a routine and its own chat
 *   GET    /api/routines/:id
 *   PATCH  /api/routines/:id          rename, reschedule, pause or resume
 *   DELETE /api/routines/:id          its chat and past runs stay
 *   POST   /api/routines/:id/run      a test run now, outside the schedule
 *   GET    /api/routines/:id/runs     its latest runs (at most ROUTINE_HISTORY_RUNS)
 *
 * The orchestrator's routine-tick starts scheduled runs; the API only writes
 * the routine and, for a test run, hands the run to the orchestrator.
 */
export function routineRoutes(
  deps: Pick<Container, "db" | "sessions" | "dispatcher" | "routines" | "logger">,
) {
  const { db } = deps;

  /** The routine's next time, once the schedule is known to be sensible. */
  function nextTime(cron: string, timeZone: string): Date {
    const schedule = parseCron(cron);
    const gap = shortestCronGapMinutes(schedule, timeZone);
    if (gap !== null && gap < ROUTINE_MIN_GAP_MINUTES) {
      throw new AppError(
        "bad_request",
        `A routine can run at most every ${ROUTINE_MIN_GAP_MINUTES} minutes; free model quotas are small`,
      );
    }
    const next = nextCronTime(schedule, new Date(), timeZone);
    if (!next) throw new AppError("bad_request", "That schedule never comes round");
    return next;
  }

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const query = readQuery(c, routineListQuerySchema);
      const rows = await listRoutines(db, c.get("tenant"), { agentId: query.agentId });
      return c.json({ items: rows.map(toRoutine) } satisfies RoutineList);
    })
    .post("/", async (c) => {
      const tenant = c.get("tenant");
      const input = await readJson(c, createRoutineRequestSchema);
      const agent = await getAgent(db, tenant, input.agentId);
      if (!agent || agent.status === "archived") throw new NotFoundError("Agent");
      const timeZone = input.timeZone ?? (await getWorkspace(db, tenant)).timeZone;
      const row = await createRoutine(db, tenant, {
        agentId: agent.id,
        name: input.name,
        instructions: input.instructions,
        cron: input.cron,
        timeZone,
        nextRunAt: nextTime(input.cron, timeZone),
        limit: ROUTINES_PER_AGENT,
      });
      return c.json(toRoutine(row), 201);
    })
    .get("/:id", async (c) => {
      const row = await getRoutine(db, c.get("tenant"), c.req.param("id"));
      if (!row) throw new NotFoundError("Routine");
      return c.json(toRoutine(row));
    })
    .patch("/:id", async (c) => {
      const tenant = c.get("tenant");
      const patch = await readJson(c, updateRoutineRequestSchema);
      const current = await getRoutine(db, tenant, c.req.param("id"));
      if (!current) throw new NotFoundError("Routine");
      const cron = patch.cron ?? current.cron;
      const timeZone = patch.timeZone ?? current.timeZone;
      const status = patch.status ?? current.status;
      const changes: Parameters<typeof updateRoutine>[3] = {
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.instructions ? { instructions: patch.instructions } : {}),
        ...(patch.cron ? { cron } : {}),
        ...(patch.timeZone ? { timeZone } : {}),
      };
      if (status === "paused") {
        Object.assign(changes, {
          status,
          nextRunAt: null,
          pausedReason: current.status === "paused" ? current.pausedReason : "person",
        } satisfies Partial<RoutineRow>);
      } else if (patch.status === "active" || patch.cron || patch.timeZone) {
        // Resuming (also after a pause for inactivity) or rescheduling: from now on.
        Object.assign(changes, {
          status,
          pausedReason: null,
          nextRunAt: nextTime(cron, timeZone),
        } satisfies Partial<RoutineRow>);
      }
      const row = await updateRoutine(db, tenant, current.id, changes);
      if (!row) throw new NotFoundError("Routine");
      return c.json(toRoutine(row));
    })
    .delete("/:id", async (c) => {
      const deleted = await deleteRoutine(db, c.get("tenant"), c.req.param("id"));
      if (!deleted) throw new NotFoundError("Routine");
      return c.body(null, 204);
    })
    .post("/:id/run", async (c) => {
      const tenant = c.get("tenant");
      const routine = await getRoutine(db, tenant, c.req.param("id"));
      if (!routine) throw new NotFoundError("Routine");
      const agent = await getAgent(db, tenant, routine.agentId);
      if (agent?.status !== "active") {
        throw new AppError(
          "conflict",
          `${agent?.name ?? "The agent"} is not active. Resume it first.`,
        );
      }
      const start = await deps.routines.testRun(tenant, routine.id);
      if (!start) throw new NotFoundError("Routine");
      try {
        await deps.dispatcher.messageReceived(start);
      } catch (error) {
        deps.logger.error("could not start a routine test run", { error, runId: start.runId });
        throw new AppError(
          "internal",
          "Couldn't start the routine: the job runner is not reachable. Is Inngest running?",
        );
      }
      const run = await getRun(db, tenant, asId<RunId>(start.runId));
      if (!run) throw new NotFoundError("Run");
      return c.json(toRun(run), 201);
    })
    .get("/:id/runs", async (c) => {
      const tenant = c.get("tenant");
      const routine = await getRoutine(db, tenant, c.req.param("id"));
      if (!routine) throw new NotFoundError("Routine");
      const rows = await listRoutineRuns(db, tenant, routine.id, ROUTINE_HISTORY_RUNS);
      return c.json({ items: rows.map(toRun) } satisfies RoutineRuns);
    });
}
