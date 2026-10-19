import { z } from "zod";
import type { Energy, Style, SuggestedEffect } from "./styles";

// The song as numbers (ADR-0049): beats, downbeats, energy and sections,
// measured by the analysis script. Sync is arithmetic on these, never the
// model's eyes: a cut lands on a frame computed from a beat time.

export const musicMapSchema = z.object({
  duration: z.number().min(0),
  tempo: z.number().min(0),
  beats: z.array(z.number().min(0)),
  downbeats: z.array(z.number().min(0)),
  /** Loudness per beat, 0 to 1 within the song. */
  energy: z.array(z.number().min(0).max(1)),
  sections: z.array(
    z.object({
      start: z.number().min(0),
      end: z.number().min(0),
      level: z.enum(["low", "mid", "high"]),
    }),
  ),
  /** Which tracker measured it. */
  tracker: z.string(),
});
export type MusicMap = z.infer<typeof musicMapSchema>;

export interface Slot {
  readonly index: number;
  /** First output frame. */
  readonly start: number;
  readonly frames: number;
  /** Where it starts in the song, in seconds. */
  readonly time: number;
  readonly level: Energy;
  readonly downbeat: boolean;
  /** The first slot of a high section after a calmer one. */
  readonly drop: boolean;
  /** Among the strongest beats of the song. */
  readonly hit: boolean;
  readonly effects: readonly SuggestedEffect[];
  /** Speed ramp suggested for this slot (into a drop). */
  readonly ramp?: readonly [number, number];
}

const near = (list: readonly number[], t: number, tol: number) =>
  list.some((x) => Math.abs(x - t) <= tol);

function levelAt(map: MusicMap, t: number): Energy {
  return map.sections.find((s) => t >= s.start && t < s.end)?.level ?? "mid";
}

/** The energy above which a beat is a hit: the top tenth. */
function hitThreshold(energy: readonly number[]): number {
  if (energy.length === 0) return Infinity;
  const sorted = [...energy].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.9)] ?? Infinity;
}

/**
 * Cut the song into slots for a style: every few beats by section energy,
 * phased to the downbeats, always at a section change, never shorter than
 * the style's shortest shot. Frames are counted from `from`, so the plan
 * lands exactly whatever the frame rate.
 */
export function planSlots(
  map: MusicMap,
  style: Style,
  options: { readonly fps: number; readonly from?: number; readonly to?: number },
): Slot[] {
  const { fps } = options;
  const from = options.from ?? 0;
  const to = Math.min(options.to ?? map.duration, map.duration);
  if (!(to > from)) return [];
  const total = Math.round((to - from) * fps);
  const step = style.beatsPerCut ?? { low: 8, mid: 4, high: 2 };
  const beatTol = map.tempo > 0 ? 30 / map.tempo / 2 : 0.1;

  const times = new Set<number>();
  const beats = map.beats.filter((b) => b >= from && b < to);
  for (const section of map.sections) {
    const inside = beats
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b >= section.start && b < section.end);
    if (inside.length === 0) continue;
    const n = step[section.level];
    // Phase to the section's first downbeat, so cuts fall on bars.
    const firstDown = inside.findIndex(({ b }) => near(map.downbeats, b, beatTol));
    const phase = firstDown >= 0 ? firstDown % n : 0;
    // A section change is always a cut, on the beat nearest its start.
    times.add(inside[0]!.b);
    inside.forEach(({ b }, k) => {
      if ((k - phase) % n === 0 && k >= phase) times.add(b);
    });
  }

  const minFrames = Math.max(1, Math.round(style.minShotSeconds * fps));
  const cuts: number[] = [0];
  for (const t of [...times].sort((a, b) => a - b)) {
    const frame = Math.round((t - from) * fps);
    if (frame - cuts[cuts.length - 1]! >= minFrames && total - frame >= minFrames) cuts.push(frame);
  }

  const threshold = hitThreshold(map.energy);
  const energyAt = (t: number) => {
    let best = -1;
    let bestGap = Infinity;
    map.beats.forEach((b, i) => {
      const gap = Math.abs(b - t);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    return best >= 0 && bestGap <= beatTol ? (map.energy[best] ?? 0) : 0;
  };

  const slots: Slot[] = cuts.map((start, index) => {
    const end = cuts[index + 1] ?? total;
    const time = from + start / fps;
    const level = levelAt(map, time);
    const previous = index > 0 ? levelAt(map, from + cuts[index - 1]! / fps) : level;
    const drop = level === "high" && previous !== "high";
    const downbeat = near(map.downbeats, time, beatTol);
    const hit = energyAt(time) >= threshold;
    const effects: SuggestedEffect[] = drop
      ? [...style.drop]
      : [...(level === "high" && downbeat ? style.downbeat : []), ...(hit ? style.hit : [])];
    return { index, start, frames: end - start, time, level, downbeat, drop, hit, effects };
  });

  if (style.rampIntoDrop) {
    return slots.map((slot, i) =>
      slots[i + 1]?.drop && slot.frames >= 6
        ? { ...slot, ramp: [1, style.rampIntoDrop!] as const }
        : slot,
    );
  }
  return slots;
}

/** How far each planned cut sits from the nearest beat, in frames. */
export function beatOffsets(
  cuts: readonly number[],
  map: MusicMap,
  options: { readonly fps: number; readonly from?: number },
): number[] {
  const from = options.from ?? 0;
  return cuts.map((frame) => {
    const t = from + frame / options.fps;
    const nearest = map.beats.reduce(
      (best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best),
      Infinity,
    );
    return Number.isFinite(nearest) ? Math.round((t - nearest) * options.fps) : 0;
  });
}
