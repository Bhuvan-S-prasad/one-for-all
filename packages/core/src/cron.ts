// Schedules in a person's time zone (M5.06–07): five-field cron expressions
// for routines, and clock times for reminders. Pure, no dependencies, so the
// API validates exactly what the orchestrator later runs.

/** A parsed cron expression: minute, hour, day of month, month, day of week. */
export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  /** 1–31. */
  readonly days: ReadonlySet<number>;
  /** 1–12. */
  readonly months: ReadonlySet<number>;
  /** 0–6, Sunday is 0 (7 is accepted for Sunday too). */
  readonly weekdays: ReadonlySet<number>;
  /** Day of month was `*`: only the weekday decides. */
  readonly anyDay: boolean;
  /** Day of week was `*`: only the day of month decides. */
  readonly anyWeekday: boolean;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(
  text: string,
  label: string,
  min: number,
  max: number,
  names?: { readonly list: readonly string[]; readonly first: number },
): Set<number> {
  const value = (token: string): number => {
    const named = names?.list.indexOf(token.toLowerCase()) ?? -1;
    const n = named >= 0 ? named + names!.first : /^\d+$/.test(token) ? Number(token) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`The ${label} field can't be "${token}" (use ${min}–${max})`);
    }
    return n;
  };
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/i.exec(part);
    if (!match) throw new Error(`The ${label} field "${text}" isn't valid`);
    const [, range, stepText] = match;
    const step = stepText ? Number(stepText) : 1;
    if (step < 1) throw new Error(`The ${label} field has a step of 0`);
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range!.split("-");
      lo = value(a!);
      hi = b === undefined ? (stepText ? max : lo) : value(b);
    }
    if (lo > hi) throw new Error(`The ${label} field runs backwards ("${part}")`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse `m h dom mon dow`; throws an error a person can read. */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("A schedule has five parts: minute, hour, day of month, month, day of week");
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = parseField(weekday, "day of week", 0, 7, { list: DAY_NAMES, first: 0 });
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: parseField(minute, "minute", 0, 59),
    hours: parseField(hour, "hour", 0, 23),
    days: parseField(day, "day of month", 1, 31),
    months: parseField(month, "month", 1, 12, { list: MONTH_NAMES, first: 1 }),
    weekdays,
    anyDay: day === "*",
    anyWeekday: weekday === "*",
  };
}

/** True when `zone` is an IANA time zone this runtime knows (`Europe/Paris`, `UTC`). */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0–6, Sunday is 0. */
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock time at `date` in `zone`. */
export function zonedParts(date: Date, zone: string): ZonedParts {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(zone, format);
  }
  const parts: Record<string, string> = {};
  for (const p of format.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: DAY_NAMES.indexOf((parts.weekday ?? "").toLowerCase().slice(0, 3)),
  };
}

function dayMatches(s: CronSchedule, p: ZonedParts): boolean {
  if (s.anyDay && s.anyWeekday) return true;
  if (s.anyDay) return s.weekdays.has(p.weekday);
  if (s.anyWeekday) return s.days.has(p.day);
  // Both restricted: either one matching is enough (as in classic cron).
  return s.days.has(p.day) || s.weekdays.has(p.weekday);
}

const MINUTE = 60_000;
/** Far enough for a schedule that only matches 29 February. */
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * MINUTE;

/** The first time after `after` (to the minute) that the schedule matches in `zone`, or null. */
export function nextCronTime(schedule: CronSchedule, after: Date, zone: string): Date | null {
  let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = t + SEARCH_LIMIT_MS;
  while (t < end) {
    const p = zonedParts(new Date(t), zone);
    if (!schedule.months.has(p.month) || !dayMatches(schedule, p)) {
      // On to the next day. Stop two hours short first, so a clock change
      // tonight can't carry the jump past tomorrow's first minutes.
      const toMidnight = (23 - p.hour) * 60 + (60 - p.minute);
      t += (toMidnight > 120 ? toMidnight - 120 : toMidnight) * MINUTE;
      continue;
    }
    if (!schedule.hours.has(p.hour)) {
      t += (60 - p.minute) * MINUTE;
      continue;
    }
    if (!schedule.minutes.has(p.minute)) {
      let next = p.minute + 1;
      while (next < 60 && !schedule.minutes.has(next)) next += 1;
      t += (next - p.minute) * MINUTE;
      continue;
    }
    return new Date(t);
  }
  return null;
}

/**
 * The shortest gap between the schedule's next `samples` times, in minutes:
 * enough to refuse one that would run every few minutes.
 */
export function shortestCronGapMinutes(
  schedule: CronSchedule,
  zone: string,
  from: Date = new Date(),
  samples = 24,
): number | null {
  let previous = nextCronTime(schedule, from, zone);
  if (!previous) return null;
  let shortest = Infinity;
  for (let i = 1; i < samples; i += 1) {
    const next = nextCronTime(schedule, previous, zone);
    if (!next) break;
    shortest = Math.min(shortest, (next.getTime() - previous.getTime()) / MINUTE);
    previous = next;
  }
  return Number.isFinite(shortest) ? shortest : null;
}

/** Minutes `zone` is ahead of UTC at `date`. */
function offsetMinutes(date: Date, zone: string): number {
  const p = zonedParts(date, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / MINUTE) * MINUTE) / MINUTE);
}

/**
 * A clock time as a moment: `2026-10-10T17:00:00+02:00` or `…Z` as written,
 * `2026-10-10 17:00` (no offset) as a wall-clock time in `zone`. Null when it
 * isn't a time.
 */
export function parseClockTime(text: string, zone: string): Date | null {
  const value = text.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
  if (!local) {
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
      return null;
    }
    const date = new Date(value.replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const [, y, mo, d, h, mi] = local.map(Number) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31 || h! > 23 || mi! > 59) return null;
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  // Correct by the zone's offset there, then once more in case that moment
  // is on the other side of a clock change.
  let at = guess - offsetMinutes(new Date(guess), zone) * MINUTE;
  at = guess - offsetMinutes(new Date(at), zone) * MINUTE;
  return new Date(at);
}

/** `2026-10-10 17:00` in `zone`, for telling a person or a model the time. */
export function formatClockTime(date: Date, zone: string): string {
  const p = zonedParts(date, zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
