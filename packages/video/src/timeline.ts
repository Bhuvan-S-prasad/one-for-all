import { z } from "zod";

// The edit as data (ADR-0049): what the agent writes and the renderer turns
// into video. Placement is in output frames, so cuts land exactly where they
// were planned; sources are read from a start in seconds. Versioned from the
// first release: a timeline written today must render the same later.

export const TIMELINE_VERSION = 1;

/** Common shapes, as width × height at 1080 lines. */
export const FORMATS = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
} as const;
export type FormatName = keyof typeof FORMATS;
export const formatNameSchema = z.enum(Object.keys(FORMATS) as [FormatName, ...FormatName[]]);

const path = z.string().min(1).max(1_000);
const even = (n: number) => n % 2 === 0;

export const effectSchema = z.object({
  type: z.enum(["flash", "shake", "zoom", "blur", "rgb_split", "black"]),
  /** First frame of the effect, counted from the clip's start. */
  at: z.number().int().min(0).default(0),
  /** How many frames it lasts. */
  frames: z.number().int().min(1).max(600).default(4),
  /** 0 to 1: how strong. */
  strength: z.number().min(0).max(1).default(0.6),
});
export type Effect = z.infer<typeof effectSchema>;

export const clipSchema = z
  .object({
    src: path,
    /** Where in the source the clip starts, in seconds. */
    from: z.number().min(0),
    /** How long the clip lasts in the output, in frames. */
    frames: z.number().int().min(1).max(36_000),
    /** Playback speed: 0.5 is half speed. A ramp goes from the first to the second over the clip. */
    speed: z.number().min(0.1).max(8).default(1),
    ramp: z.tuple([z.number().min(0.1).max(8), z.number().min(0.1).max(8)]).optional(),
    /** `cover` fills the frame (cropping); `contain` shows it whole on black. */
    fit: z.enum(["cover", "contain"]).default("cover"),
    /** Where to keep when cropping: 0 is the left (or top) edge, 1 the right (or bottom). */
    focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0.5, 0.5]),
    /** The clip's own sound, in dB (0 is as recorded); left out, the clip is silent. */
    audio: z.number().min(-60).max(12).optional(),
    effects: z.array(effectSchema).max(20).default([]),
    /** Why this shot is here, for people reading the plan. */
    note: z.string().max(300).optional(),
  })
  .refine((c) => !(c.ramp && c.audio !== undefined), {
    message: "A ramped clip has no sound of its own; leave out audio",
  });
export type Clip = z.infer<typeof clipSchema>;

export const captionSchema = z.object({
  text: z.string().min(1).max(200),
  /** Output time in seconds. */
  start: z.number().min(0),
  end: z.number().min(0),
});
export type Caption = z.infer<typeof captionSchema>;

export const GRADES = ["none", "punchy", "teal_orange", "warm", "cold", "faded", "mono"] as const;

export const timelineSchema = z.object({
  version: z.literal(TIMELINE_VERSION),
  output: z.object({
    width: z.number().int().min(64).max(3840).refine(even, "width must be even"),
    height: z.number().int().min(64).max(3840).refine(even, "height must be even"),
    fps: z.number().int().min(12).max(60).default(30),
  }),
  music: z
    .object({
      src: path,
      /** Where in the song the edit starts, in seconds. */
      from: z.number().min(0).default(0),
      gain: z.number().min(-60).max(12).default(0),
      /** Fade out over the last seconds. */
      fadeOut: z.number().min(0).max(10).default(1),
    })
    .optional(),
  clips: z.array(clipSchema).min(1).max(500),
  captions: z
    .object({
      style: z.enum(["bold_center", "bottom", "karaoke"]).default("bold_center"),
      /** Written lines, at output times. */
      lines: z.array(captionSchema).max(2_000).default([]),
      /** Also caption what is said in clips that keep their sound, transcribed. */
      fromSpeech: z.boolean().default(false),
      wordsPerLine: z.number().int().min(1).max(8).default(3),
    })
    .optional(),
  grade: z
    .object({
      preset: z.enum(GRADES).default("none"),
      /** A .cube LUT, applied after the preset. */
      lut: path.optional(),
    })
    .default({ preset: "none" }),
});
export type Timeline = z.infer<typeof timelineSchema>;
export type TimelineInput = z.input<typeof timelineSchema>;

/** Total length in frames. */
export function totalFrames(timeline: Timeline): number {
  return timeline.clips.reduce((sum, c) => sum + c.frames, 0);
}

/** The output frame where each clip starts; the first is 0. */
export function cutFrames(timeline: Timeline): number[] {
  const cuts: number[] = [];
  let at = 0;
  for (const clip of timeline.clips) {
    cuts.push(at);
    at += clip.frames;
  }
  return cuts;
}

/** How many seconds of source a clip uses: its length times its speed (the mean of a ramp). */
export function sourceSeconds(clip: Clip, fps: number): number {
  const seconds = clip.frames / fps;
  return clip.ramp ? (seconds * (clip.ramp[0] + clip.ramp[1])) / 2 : seconds * clip.speed;
}

/** The same edit at another size: every clip keeps its framing rules. */
export function inFormat(timeline: Timeline, format: FormatName): Timeline {
  return { ...timeline, output: { ...timeline.output, ...FORMATS[format] } };
}
