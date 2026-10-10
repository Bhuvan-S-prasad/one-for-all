import { describe, expect, it } from "vitest";
import {
  formatClockTime,
  isTimeZone,
  nextCronTime,
  parseClockTime,
  parseCron,
  shortestCronGapMinutes,
} from "./index";

const next = (cron: string, after: string, zone = "UTC") =>
  nextCronTime(parseCron(cron), new Date(after), zone)?.toISOString() ?? null;

describe("parseCron", () => {
  it("reads lists, ranges, steps and names", () => {
    const s = parseCron("*/15 7-9 1,15 jan-mar MON-FRI");
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect([...s.hours]).toEqual([7, 8, 9]);
    expect([...s.days]).toEqual([1, 15]);
    expect([...s.months]).toEqual([1, 2, 3]);
    expect([...s.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(s.anyDay).toBe(false);
  });

  it("takes 7 as Sunday", () => {
    expect([...parseCron("0 9 * * 7").weekdays]).toEqual([0]);
  });

  it("explains what is wrong", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/five parts/);
    expect(() => parseCron("61 9 * * *")).toThrow(/minute field can't be "61"/);
    expect(() => parseCron("0 9-7 * * *")).toThrow(/backwards/);
    expect(() => parseCron("0 9 * * funday")).toThrow(/day of week/);
  });
});

describe("nextCronTime", () => {
  it("finds the next weekday morning", () => {
    // Friday 2026-10-09 08:00 UTC → Monday 07:00.
    expect(next("0 7 * * 1-5", "2026-10-09T08:00:00Z")).toBe("2026-10-12T07:00:00.000Z");
    expect(next("0 7 * * 1-5", "2026-10-09T06:59:30Z")).toBe("2026-10-09T07:00:00.000Z");
  });

  it("never returns the minute it starts in", () => {
    expect(next("0 7 * * *", "2026-10-09T07:00:00Z")).toBe("2026-10-10T07:00:00.000Z");
  });

  it("reads the time in the routine's zone, across clock changes", () => {
    // 07:00 in London is 06:00 UTC in summer time and 07:00 UTC after 25 October.
    expect(next("0 7 * * *", "2026-10-24T12:00:00Z", "Europe/London")).toBe(
      "2026-10-25T07:00:00.000Z",
    );
    expect(next("0 7 * * *", "2026-10-23T12:00:00Z", "Europe/London")).toBe(
      "2026-10-24T06:00:00.000Z",
    );
    expect(next("30 0 * * *", "2026-03-28T12:00:00Z", "Europe/London")).toBe(
      "2026-03-29T00:30:00.000Z",
    );
    expect(next("0 9 * * *", "2026-10-10T00:00:00Z", "Asia/Kolkata")).toBe(
      "2026-10-10T03:30:00.000Z",
    );
  });

  it("matches either day when both day fields are set, as cron does", () => {
    // The 13th, or any Friday: Friday the 16th comes first after the 13th.
    expect(next("0 12 13 * 5", "2026-10-13T13:00:00Z")).toBe("2026-10-16T12:00:00.000Z");
  });

  it("finds 29 February and gives up on 30 February", () => {
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 0 30 2 *", "2026-03-01T00:00:00Z")).toBeNull();
  });
});

describe("shortestCronGapMinutes", () => {
  it("measures how often a schedule runs", () => {
    expect(shortestCronGapMinutes(parseCron("*/5 * * * *"), "UTC")).toBe(5);
    expect(shortestCronGapMinutes(parseCron("0,1 9 * * *"), "UTC")).toBe(1);
    expect(shortestCronGapMinutes(parseCron("0 7 * * 1-5"), "UTC")).toBeGreaterThanOrEqual(1440);
  });
});

describe("clock times", () => {
  it("reads a time without an offset in the given zone", () => {
    expect(parseClockTime("2026-10-10 17:00", "Europe/Paris")?.toISOString()).toBe(
      "2026-10-10T15:00:00.000Z",
    );
    expect(parseClockTime("2026-12-10T17:00", "Europe/Paris")?.toISOString()).toBe(
      "2026-12-10T16:00:00.000Z",
    );
  });

  it("takes an offset as written", () => {
    expect(parseClockTime("2026-10-10T17:00:00+05:30", "UTC")?.toISOString()).toBe(
      "2026-10-10T11:30:00.000Z",
    );
    expect(parseClockTime("2026-10-10T17:00Z", "Asia/Tokyo")?.toISOString()).toBe(
      "2026-10-10T17:00:00.000Z",
    );
  });

  it("refuses what isn't a time", () => {
    expect(parseClockTime("tomorrow at five", "UTC")).toBeNull();
    expect(parseClockTime("2026-13-10 17:00", "UTC")).toBeNull();
  });

  it("formats in the zone", () => {
    expect(formatClockTime(new Date("2026-10-10T15:00:00Z"), "Europe/Paris")).toBe(
      "2026-10-10 17:00",
    );
  });

  it("knows time zones", () => {
    expect(isTimeZone("Europe/Paris")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});
