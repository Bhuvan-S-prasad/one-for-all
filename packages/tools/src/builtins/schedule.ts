import { formatClockTime, parseClockTime, type RunContext, type Scheduler } from "@ofa/core";
import { z } from "zod";
import { defineTool, type ToolRunContext } from "../define";

// Prospective memory (ARCHITECTURE.md §8, M5.07): an agent sets something
// for later. A reminder is posted as written when it is due, with no model
// call; a task wakes the agent then, in the same conversation, to do it.

export const SCHEDULE_TASK = "schedule_task";
export const REMIND_ME = "remind_me";

/** How far ahead an item may be set (SCHEDULE_MAX_AHEAD_DAYS in the contracts). */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;

const when = {
  at: z
    .string()
    .trim()
    .max(40)
    .optional()
    .describe(
      "When, as a clock time in the person's time zone (2026-10-10 17:00), or ISO 8601 with an offset",
    ),
  in_minutes: z
    .number()
    .int()
    .min(1)
    .max(525_600)
    .optional()
    .describe("Or how many minutes from now, instead of at"),
};

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The moment an item is due, from `at` or `in_minutes`; throws an error the model can act on. */
async function dueAt(
  scheduler: Scheduler,
  ctx: ToolRunContext,
  input: { at?: string | undefined; in_minutes?: number | undefined },
  now = Date.now(),
): Promise<{ date: Date; zone: string }> {
  const zone = await scheduler.timeZone(ctx);
  if ((input.at === undefined) === (input.in_minutes === undefined)) {
    throw coded("bad_time", "Give either at (a clock time) or in_minutes, not both.");
  }
  const date =
    input.in_minutes !== undefined
      ? new Date(now + input.in_minutes * 60_000)
      : parseClockTime(input.at!, zone);
  if (!date) {
    throw coded(
      "bad_time",
      `"${input.at}" isn't a time I can read. Write it like ${formatClockTime(new Date(now), zone)}, or use in_minutes.`,
    );
  }
  if (date.getTime() < now + 30_000) {
    throw coded(
      "bad_time",
      `That time has passed: it is now ${formatClockTime(new Date(now), zone)} (${zone}).`,
    );
  }
  if (date.getTime() > now + MAX_AHEAD_MS) {
    throw coded("bad_time", "That is more than a year away; pick a sooner time.");
  }
  return { date, zone };
}

async function listedWithClock(scheduler: Scheduler | null, ctx: RunContext, text: string) {
  if (!scheduler) return null;
  const zone = await scheduler.timeZone(ctx);
  return {
    description: `${text}\nIt is now ${formatClockTime(new Date(), zone)} in the person's time zone (${zone}).`,
  };
}

const notConfigured = () =>
  coded("not_configured", "Nothing can be scheduled for later on this server.");

const REMIND_DESCRIPTION =
  'Remind the person of something later. At that time your message is posted in this conversation exactly as you write it now, so write it for then ("Call the dentist about Friday"). Use schedule_task instead when you need to do work at that time.';

export function remindMeTool(scheduler: Scheduler | null) {
  return defineTool({
    name: REMIND_ME,
    description: REMIND_DESCRIPTION,
    input: z.object({
      ...when,
      message: z
        .string()
        .trim()
        .min(3)
        .max(1_000)
        .describe("The reminder, as the person should read it then"),
    }),
    // It posts in this conversation later; nothing leaves the workspace.
    annotations: { readOnly: false, destructive: false, outbound: false, idempotent: true },
    editable: ["message"],
    listed: (ctx) => listedWithClock(scheduler, ctx, REMIND_DESCRIPTION),
    async describe({ at, in_minutes, message }) {
      const time = at ?? `in ${in_minutes} minutes`;
      return `Remind you ${at ? `at ${time}` : time}: “${message}”`;
    },
    async run(input, ctx) {
      if (!scheduler) throw notConfigured();
      const { date, zone } = await dueAt(scheduler, ctx, input);
      await scheduler.schedule(ctx, {
        key: ctx.idempotencyKey,
        kind: "reminder",
        content: input.message,
        dueAt: date,
      });
      return {
        content: `Reminder set for ${formatClockTime(date, zone)} (${zone}). It will be posted in this conversation then.`,
        untrusted: false,
      };
    },
  });
}

const TASK_DESCRIPTION =
  "Do a task later: at that time you are woken in this conversation with the task as your request, and do it with your tools (check a page, prepare a summary, follow up). Write the task so you can act on it alone then. Use remind_me instead to only remind the person.";

export function scheduleTaskTool(scheduler: Scheduler | null) {
  return defineTool({
    name: SCHEDULE_TASK,
    description: TASK_DESCRIPTION,
    input: z.object({
      ...when,
      task: z
        .string()
        .trim()
        .min(10, "Write a task you can act on alone later")
        .max(2_000)
        .describe("What to do then, with what you'll need to know"),
    }),
    // It wakes this agent later; that run's calls each go through policy, and
    // it starts tainted if this run is (ADR-0013).
    annotations: { readOnly: false, destructive: false, outbound: false, idempotent: true },
    editable: ["task"],
    listed: (ctx) => listedWithClock(scheduler, ctx, TASK_DESCRIPTION),
    async describe({ at, in_minutes, task }) {
      const start = task.length > 160 ? `${task.slice(0, 159)}…` : task;
      return `Do later (${at ?? `in ${in_minutes} minutes`}): “${start}”`;
    },
    async run(input, ctx) {
      if (!scheduler) throw notConfigured();
      const { date, zone } = await dueAt(scheduler, ctx, input);
      await scheduler.schedule(ctx, {
        key: ctx.idempotencyKey,
        kind: "task",
        content: input.task,
        dueAt: date,
      });
      return {
        content: `Scheduled for ${formatClockTime(date, zone)} (${zone}). You'll be woken in this conversation then to do it; you won't see the result in this turn.`,
        untrusted: false,
      };
    },
  });
}
