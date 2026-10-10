// Schedules in plain words (M5.11): the routines page writes cron from a few
// choices and reads it back as a sentence. Anything else shows as written.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type SchedulePreset =
  | { readonly kind: "daily"; readonly time: string }
  | { readonly kind: "weekdays"; readonly time: string }
  | { readonly kind: "weekly"; readonly day: number; readonly time: string }
  | { readonly kind: "hourly"; readonly every: number; readonly minute: number }
  | { readonly kind: "custom"; readonly cron: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** `07:30` → [7, 30]; anything else → [9, 0]. */
function clock(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return [9, 0];
  const h = Math.min(23, Number(match[1]));
  const m = Math.min(59, Number(match[2]));
  return [h, m];
}

export function presetToCron(preset: SchedulePreset): string {
  if (preset.kind === "custom") return preset.cron.trim();
  if (preset.kind === "hourly") {
    const every = Math.max(1, Math.min(12, Math.round(preset.every)));
    return `${preset.minute} ${every === 1 ? "*" : `*/${every}`} * * *`;
  }
  const [h, m] = clock(preset.time);
  if (preset.kind === "daily") return `${m} ${h} * * *`;
  if (preset.kind === "weekdays") return `${m} ${h} * * 1-5`;
  return `${m} ${h} * * ${preset.day}`;
}

/** The closest preset for a cron, so the form opens on what was chosen. */
export function cronToPreset(cron: string): SchedulePreset {
  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
    const fixed = /^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*";
    const time = `${pad(Number(hour))}:${pad(Number(min))}`;
    if (fixed && dow === "*") return { kind: "daily", time };
    if (fixed && dow === "1-5") return { kind: "weekdays", time };
    if (fixed && /^[0-6]$/.test(dow)) return { kind: "weekly", day: Number(dow), time };
    const every = /^\*(?:\/(\d+))?$/.exec(hour);
    if (/^\d+$/.test(min) && every && dom === "*" && mon === "*" && dow === "*") {
      return { kind: "hourly", every: every[1] ? Number(every[1]) : 1, minute: Number(min) };
    }
  }
  return { kind: "custom", cron };
}

/** "Weekdays at 07:00", "Every 2 hours at :15", or the cron as written. */
export function describeCron(cron: string): string {
  const preset = cronToPreset(cron);
  switch (preset.kind) {
    case "daily":
      return `Every day at ${preset.time}`;
    case "weekdays":
      return `Weekdays at ${preset.time}`;
    case "weekly":
      return `Every ${DAYS[preset.day]} at ${preset.time}`;
    case "hourly":
      return preset.every === 1
        ? `Every hour at :${pad(preset.minute)}`
        : `Every ${preset.every} hours at :${pad(preset.minute)}`;
    default:
      return `On the schedule ${cron.trim()}`;
  }
}

export const WEEKDAY_NAMES = DAYS;
