import { describe, expect, it } from "vitest";
import { autoCut, momentsFrom, type Moment } from "./autocut";
import { planSlots, type MusicMap } from "./music";
import { styleById } from "./styles";
import { cutFrames, totalFrames } from "./timeline";

// Cutting a song from a pool of shots (ADR-0049), without ffmpeg.

/** 120 BPM for 16 s: quiet for 8 s, then loud. */
function song(): MusicMap {
  const beats = Array.from({ length: 32 }, (_, i) => i * 0.5);
  return {
    duration: 16,
    tempo: 120,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    energy: beats.map((b) => (b < 8 ? 0.3 : 0.9)),
    sections: [
      { start: 0, end: 8, level: "low" },
      { start: 8, end: 16, level: "high" },
    ],
    tracker: "test",
  };
}

const moment = (
  name: string,
  start: number,
  end: number,
  motion: number,
  peak: number,
): Moment => ({
  src: `/w/${name}.mp4`,
  start,
  end,
  motion,
  peak,
});

const pool = [
  moment("calm", 0, 8, 1.2, 3),
  moment("walk", 8, 14, 2.5, 10),
  moment("chase", 20, 26, 6, 22),
  moment("fight", 30, 34, 12, 31.5),
];

const amv = styleById("amv")!;
const slots = planSlots(song(), amv, { fps: 30 });
const cut = autoCut({
  slots,
  moments: pool,
  fps: 30,
  output: { width: 1920, height: 1080 },
  styleId: "amv",
  music: { src: "/w/song.mp3", from: 0 },
  credit: "Credit line",
});

describe("filling the slots", () => {
  it("keeps every slot's frames, so every cut stays on the beat", () => {
    expect(cut.timeline.clips.map((c) => c.frames)).toEqual(slots.map((s) => s.frames));
    expect(totalFrames(cut.timeline)).toBe(480);
    expect(cutFrames(cut.timeline)).toEqual(slots.map((s) => s.start));
  });

  it("never uses the same shot in two slots in a row", () => {
    for (let i = 1; i < cut.picks.length; i++) {
      expect(cut.picks[i]!.moment).not.toBe(cut.picks[i - 1]!.moment);
    }
  });

  it("puts the strongest shot on the drop, starting just before its peak", () => {
    const drop = slots.findIndex((s) => s.drop);
    const pick = cut.picks[drop]!;
    expect(pick.moment.src).toBe("/w/fight.mp4");
    // The peak (31.5 s) lands 0.12 s after the cut.
    expect(pick.from).toBeCloseTo(31.38, 2);
    // And the drop's suggested effects are on it.
    expect(cut.timeline.clips[drop]!.effects.map((e) => e.type)).toEqual(["flash", "zoom"]);
  });

  it("saves the strongest shots for loud slots", () => {
    const calm = cut.picks.filter((_, i) => slots[i]!.level === "low").map((p) => p.moment.src);
    expect(calm).not.toContain("/w/fight.mp4");
    const loud = cut.picks.filter((_, i) => slots[i]!.level === "high").map((p) => p.moment.src);
    expect(new Set(loud)).toEqual(new Set(["/w/fight.mp4", "/w/chase.mp4"]));
  });

  it("shows a different stretch when a shot comes back, and never runs past its end", () => {
    const fights = cut.picks
      .map((p, i) => ({ p, c: cut.timeline.clips[i]! }))
      .filter(({ p }) => p.moment.src === "/w/fight.mp4");
    const starts = fights.map(({ p }) => p.from);
    expect(new Set(starts).size).toBeGreaterThan(1);
    for (const { p, c } of fights) {
      expect(p.from).toBeGreaterThanOrEqual(30);
      expect(p.from + (c.frames / 30) * (c.ramp ? 2 : 1)).toBeLessThanOrEqual(34 + 1e-6);
    }
  });

  it("carries the music, the style's grade, a credit line and a valid timeline", () => {
    expect(cut.timeline.music).toMatchObject({ src: "/w/song.mp3", from: 0 });
    expect(cut.timeline.grade.preset).toBe("punchy");
    expect(cut.timeline.captions?.lines).toEqual([{ text: "Credit line", start: 0.3, end: 4.3 }]);
    expect(cut.timeline.output).toMatchObject({ width: 1920, height: 1080, fps: 30 });
  });

  it("stays small enough for a model to read: a 67-slot song fits a few thousand characters", () => {
    const long = Array.from({ length: 304 }, (_, i) => i * 0.395);
    const map: MusicMap = {
      duration: 120,
      tempo: 152,
      beats: long,
      downbeats: long.filter((_, i) => i % 4 === 0),
      energy: long.map(() => 0.9),
      sections: [{ start: 0, end: 120, level: "high" }],
      tracker: "test",
    };
    const many = planSlots(map, amv, { fps: 30, from: 10, to: 40 });
    expect(many.length).toBeGreaterThan(60);
    const big = autoCut({
      slots: many,
      moments: pool,
      fps: 30,
      output: { width: 1080, height: 1920 },
      styleId: "amv",
    });
    expect(big.timeline.clips).toHaveLength(many.length);
  });
});

describe("choosing shots", () => {
  it("leaves out stills, flashes and very short shots", () => {
    const shots = [
      { start: 0, end: 5, motion: 1.6, peak: 3.6 },
      { start: 5, end: 5.2, motion: 0, peak: 5 },
      { start: 5.2, end: 5.4, motion: 9.8, peak: 5.3 },
      { start: 6, end: 9, motion: 0.1, peak: 7 },
    ];
    expect(momentsFrom("/w/a.mp4", shots).map((m) => m.start)).toEqual([0]);
  });

  it("explains when there is nothing to cut", () => {
    expect(() =>
      autoCut({ slots, moments: [], fps: 30, output: { width: 640, height: 360 }, styleId: "amv" }),
    ).toThrow(/no shots with enough motion/);
  });

  it("still fills the slots from one short shot, holding its last frame", () => {
    const one = autoCut({
      slots,
      moments: [moment("tiny", 0, 0.4, 5, 0.2)],
      fps: 30,
      output: { width: 640, height: 360 },
      styleId: "amv",
    });
    expect(one.timeline.clips).toHaveLength(slots.length);
  });
});
