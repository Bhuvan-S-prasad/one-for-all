import { describe, expect, it } from "vitest";
import { cronToPreset, describeCron, presetToCron } from "./schedule";

describe("schedules in words (M5.11)", () => {
  it("writes cron from the form's choices", () => {
    expect(presetToCron({ kind: "weekdays", time: "07:30" })).toBe("30 7 * * 1-5");
    expect(presetToCron({ kind: "daily", time: "21:05" })).toBe("5 21 * * *");
    expect(presetToCron({ kind: "weekly", day: 1, time: "09:00" })).toBe("0 9 * * 1");
    expect(presetToCron({ kind: "hourly", every: 2, minute: 15 })).toBe("15 */2 * * *");
    expect(presetToCron({ kind: "hourly", every: 1, minute: 0 })).toBe("0 * * * *");
  });

  it("reads them back as sentences", () => {
    expect(describeCron("30 7 * * 1-5")).toBe("Weekdays at 07:30");
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00");
    expect(describeCron("15 */2 * * *")).toBe("Every 2 hours at :15");
    expect(describeCron("0 8 1 * *")).toBe("On the schedule 0 8 1 * *");
  });

  it("opens the form on what was chosen", () => {
    expect(cronToPreset("5 21 * * *")).toEqual({ kind: "daily", time: "21:05" });
    expect(cronToPreset("0 8 1 * *")).toEqual({ kind: "custom", cron: "0 8 1 * *" });
  });
});
