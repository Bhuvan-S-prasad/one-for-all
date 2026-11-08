import type { Shot } from "./parse";
import type { Slot } from "./music";
import { styleById } from "./styles";
import {
  sourceSeconds,
  timelineSchema,
  type Clip,
  type Timeline,
  type TimelineInput,
} from "./timeline";

// Cutting a song from a pool of shots (ADR-0049). A model can't type a
// 67-clip timeline within a free model's output limit (a live run was cut off
// at 6,000 tokens and answered with nothing), and shouldn't do the arithmetic
// anyway. So the engine fills the slots: the strongest shot on the drop and
// the hits, calm shots in calm sections, each shot started just before its
// motion peak so the action lands on the cut, and no shot twice in a row.
// The model still chooses the song part, the sources and the style, and reads
// the result before it renders.

export interface Moment {
  readonly src: string;
  readonly start: number;
  readonly end: number;
  /** Mean motion through the shot, 0 to 100. */
  readonly motion: number;
  /** When it moves most. */
  readonly peak: number;
}

/** Shots worth cutting: long enough to use, and not a still or a flash. */
export function momentsFrom(
  src: string,
  shots: readonly Shot[],
  options: { readonly minSeconds?: number; readonly minMotion?: number } = {},
): Moment[] {
  const minSeconds = options.minSeconds ?? 0.5;
  const minMotion = options.minMotion ?? 0.3;
  return shots
    .filter((s) => s.end - s.start >= minSeconds && s.motion >= minMotion)
    .map((s) => ({ src, start: s.start, end: s.end, motion: s.motion, peak: s.peak }));
}

export interface AutoCutOptions {
  readonly slots: readonly Slot[];
  readonly moments: readonly Moment[];
  readonly fps: number;
  readonly output: { readonly width: number; readonly height: number };
  readonly styleId: string;
  readonly music?: { readonly src: string; readonly from: number };
  /** Shown near the start, for credits. */
  readonly credit?: string;
}

interface Pick {
  readonly moment: Moment;
  readonly from: number;
  readonly note: string;
}

/** How far before its peak a shot starts, so the peak lands just after the cut. */
const LEAD_SECONDS = 0.12;

export function autoCut(options: AutoCutOptions): { timeline: Timeline; picks: Pick[] } {
  const { slots, moments, fps } = options;
  const style = styleById(options.styleId);
  if (!style) throw new Error(`No style called ${options.styleId}`);
  if (moments.length === 0) {
    throw new Error("There are no shots with enough motion to cut; scan the footage first");
  }
  if (slots.length === 0) throw new Error("The song part has no slots to fill");

  // Strongest first: ranks decide which shots a calm or a loud slot may use.
  const ranked = [...moments].sort((a, b) => b.motion - a.motion);
  const used = new Map<Moment, number>();
  let previous: Moment | null = null;
  const picks: Pick[] = [];

  const need = (slot: Slot) =>
    sourceSeconds(
      { frames: slot.frames, speed: 1, ...(slot.ramp ? { ramp: [...slot.ramp] } : {}) } as Clip,
      fps,
    );

  for (const slot of slots) {
    const seconds = need(slot);
    const strong = slot.drop || slot.hit;
    // The loud slots draw on the top half; calm ones on the rest, so the
    // best shots are saved for when the music earns them.
    const half = Math.max(1, Math.ceil(ranked.length / 2));
    const pool =
      strong || slot.level === "high"
        ? ranked.slice(0, half)
        : slot.level === "mid"
          ? ranked
          : ranked.slice(Math.min(half, ranked.length - 1));
    const fits = (m: Moment) => m.end - m.start >= seconds;
    let candidates = pool.filter((m) => m !== previous && fits(m));
    if (candidates.length === 0) candidates = ranked.filter((m) => m !== previous && fits(m));
    if (candidates.length === 0) candidates = ranked.filter((m) => m !== previous);
    if (candidates.length === 0) candidates = [...ranked];
    // Least used first (so shots come back evenly), then the strongest. The
    // drop takes the strongest outright.
    const chosen = slot.drop
      ? (candidates[0] as Moment)
      : candidates.reduce((best, m) => {
          const a = used.get(m) ?? 0;
          const b = used.get(best) ?? 0;
          return a < b ? m : best;
        }, candidates[0] as Moment);

    const before = used.get(chosen) ?? 0;
    const room = Math.max(0, chosen.end - chosen.start - seconds);
    let from: number;
    if (before === 0) {
      from = Math.min(Math.max(chosen.start, chosen.peak - LEAD_SECONDS), chosen.start + room);
    } else {
      // Back again: a different stretch of the same shot.
      from = chosen.start + (room > 0 ? before % (room + 0.001) : 0);
    }
    used.set(chosen, before + seconds);
    previous = chosen;
    picks.push({
      moment: chosen,
      from: Number(from.toFixed(3)),
      note: `${slot.drop ? "drop" : slot.hit ? "hit" : slot.level} · motion ${chosen.motion.toFixed(1)}`,
    });
  }

  const clips: Clip[] = slots.map((slot, i) => {
    const pick = picks[i]!;
    return {
      src: pick.moment.src,
      from: pick.from,
      frames: slot.frames,
      speed: 1,
      fit: "cover",
      focus: [0.5, 0.5],
      ...(slot.ramp ? { ramp: [slot.ramp[0], slot.ramp[1]] as [number, number] } : {}),
      effects: slot.effects.map((e) => ({
        type: e.type,
        at: e.at ?? 0,
        frames: e.frames,
        strength: e.strength,
      })),
      note: pick.note,
    };
  });

  const input: TimelineInput = {
    version: 1,
    output: { ...options.output, fps },
    ...(options.music ? { music: { src: options.music.src, from: options.music.from } } : {}),
    clips,
    ...(options.credit
      ? {
          captions: {
            style: "bottom" as const,
            lines: [{ text: options.credit, start: 0.3, end: 4.3 }],
          },
        }
      : {}),
    grade: { preset: style.grade },
  };
  return { timeline: timelineSchema.parse(input), picks };
}
