import { scheduleListQuerySchema, type ScheduleList } from "@ofa/contracts";
import { AppError, NotFoundError } from "@ofa/core";
import { cancelSchedule, getSchedule, listSchedules } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { toSchedule } from "../lib/mappers";
import { readQuery } from "../lib/validate";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * What agents set for later (M5.07, ADR-0035):
 *   GET    /api/schedules        soonest first (?agentId=&status=pending)
 *   DELETE /api/schedules/:id    cancel a pending task or reminder
 *
 * Agents set items with `schedule_task` and `remind_me`; the orchestrator's
 * schedule-fire sleeps until each is due.
 */
export function scheduleRoutes(deps: Pick<Container, "db" | "sessions" | "dispatcher" | "logger">) {
  const { db } = deps;

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/", async (c) => {
      const query = readQuery(c, scheduleListQuerySchema);
      const rows = await listSchedules(db, c.get("tenant"), query);
      return c.json({ items: rows.map(toSchedule) } satisfies ScheduleList);
    })
    .delete("/:id", async (c) => {
      const tenant = c.get("tenant");
      const cancelled = await cancelSchedule(db, tenant, c.req.param("id"));
      if (!cancelled) {
        const existing = await getSchedule(db, tenant, c.req.param("id"));
        if (!existing) throw new NotFoundError("Scheduled item");
        throw new AppError("conflict", `It is already ${existing.status}`);
      }
      // The row now says cancelled, which is what counts; ending the wait
      // early is tidiness, so a failure here is only logged.
      await deps.dispatcher
        .scheduleCancelled({
          workspaceId: tenant.workspaceId,
          userId: tenant.userId,
          scheduleId: cancelled.id,
        })
        .catch((error: unknown) =>
          deps.logger.warn("could not end a cancelled item's wait", { error, id: cancelled.id }),
        );
      return c.json(toSchedule(cancelled));
    });
}
