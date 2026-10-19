import { z } from "zod";
import type { VideoEngine } from "./engine";
import { STYLES, styleById } from "./styles";
import { FORMATS, formatNameSchema, inFormat, timelineSchema, type Timeline } from "./timeline";

// The engine's tools (ADR-0049), defined once for both front doors: the MCP
// server serves them as they are, and One-for-All wraps each in its own tool
// with grants and policy. Results are short text a small model can read;
// long data stays in files the next tool reads by path.

export interface VideoToolResult {
  readonly text: string;
  /** A picture the tool made (a contact sheet), for a model that reads images. */
  readonly image?: string;
  /** Files the tool wrote. */
  readonly files?: readonly string[];
}

export interface VideoTool<S extends z.ZodType = z.ZodType> {
  /** One word; One-for-All names it `video.<name>`. */
  readonly name: string;
  readonly description: string;
  readonly input: S;
  /** Only reads and analyses; writes nothing but the engine's own work files. */
  readonly readOnly: boolean;
  /** Longest it may take. */
  readonly timeoutMs: number;
  run(engine: VideoEngine, args: z.infer<S>): Promise<VideoToolResult>;
}

const define = <S extends z.ZodType>(tool: VideoTool<S>) => tool;

const path = z.string().min(1).max(1_000);
const s = (n: number) => n.toFixed(2);

/** A timeline given inline or as a JSON file. */
/**
 * A timeline given inline or as a JSON file. Only render shows the full
 * schema (a live run guessed the fields without it); repeating it in every
 * tool would cost about 800 tokens each.
 */
const timelineArgs = {
  timeline: z
    .unknown()
    .optional()
    .describe("The timeline object, as given to render (not a string); or give timeline_file"),
  timeline_file: path.optional().describe("A JSON file holding the timeline"),
};
const renderTimelineArgs = {
  ...timelineArgs,
  timeline: timelineSchema
    .optional()
    .describe("The timeline, as an object (not a string); or give timeline_file"),
};

async function timelineOf(
  args: { timeline?: unknown; timeline_file?: string },
  read: (path: string) => Promise<string>,
): Promise<Timeline> {
  let raw: unknown =
    args.timeline ?? (args.timeline_file ? JSON.parse(await read(args.timeline_file)) : null);
  // Models sometimes send the object as a JSON string.
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error("The timeline is a string that isn't JSON; send it as an object");
    }
  }
  if (raw === null || raw === undefined) throw new Error("Give timeline or timeline_file");
  const parsed = timelineSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`The timeline doesn't fit: ${parsed.error.message}`);
  return parsed.data;
}

export function videoTools(read: (path: string) => Promise<string>): VideoTool[] {
  return [
    define({
      name: "scan",
      description:
        "Look at a video file without watching it: size, frame rate, length, sound, and its shots with how much each moves and when it moves most (motion peaks are where action is). Do this for every source first.",
      input: z.object({ path: path.describe("The video file") }),
      readOnly: true,
      timeoutMs: 20 * 60_000,
      async run(engine, { path: p }) {
        const { info, shots } = await engine.scan(p);
        const head = `${p}: ${info.width}×${info.height}, ${info.fps ?? "?"} fps, ${s(info.duration)} s, sound: ${info.hasAudio ? "yes" : "no"}. ${shots.length} shots (start–end s, motion 0–100, peak s):`;
        const lines = shots
          .slice(0, 300)
          .map((x) => `${s(x.start)}–${s(x.end)} motion ${x.motion.toFixed(1)} peak ${s(x.peak)}`);
        const more = shots.length > 300 ? [`…and ${shots.length - 300} more`] : [];
        return { text: [head, ...lines, ...more].join("\n") };
      },
    }),
    define({
      name: "music",
      description:
        "Measure a song (or any file's sound): tempo, beats, downbeats, and sections by energy (low, mid, high). Cutting to music always starts here; plan_beats reads the result by the same path.",
      input: z.object({ path: path.describe("The song or a file with sound") }),
      readOnly: true,
      timeoutMs: 15 * 60_000,
      async run(engine, { path: p }) {
        const map = await engine.music(p);
        const sections = map.sections.map((x) => `${s(x.start)}–${s(x.end)} ${x.level}`).join("; ");
        return {
          text: `${p}: ${map.tempo.toFixed(1)} BPM, ${s(map.duration)} s, ${map.beats.length} beats, ${map.downbeats.length} bars (${map.tracker}). Sections: ${sections}. First downbeats: ${map.downbeats
            .slice(0, 8)
            .map(s)
            .join(", ")}.`,
        };
      },
    }),
    define({
      name: "transcribe",
      description:
        "Every spoken word in a file with its time, shown as lines. Use it to cut on words (remove pauses, filler and retakes) and to check captions.",
      input: z.object({
        path,
        language: z
          .string()
          .min(2)
          .max(5)
          .optional()
          .describe("Like en or hi; left out, it is detected"),
      }),
      readOnly: true,
      timeoutMs: 60 * 60_000,
      async run(engine, { path: p, language }) {
        const t = await engine.transcribe(p, language ? { language } : {});
        const lines: string[] = [];
        let line: typeof t.words = [];
        const flush = () => {
          if (line.length) {
            lines.push(
              `[${s(line[0]!.start)}–${s(line[line.length - 1]!.end)}] ${line.map((w) => w.text).join(" ")}`,
            );
          }
          line = [];
        };
        for (const w of t.words) {
          const last = line[line.length - 1];
          if (last && (w.start - last.end > 0.6 || line.length >= 12)) flush();
          line = [...line, w];
        }
        flush();
        return {
          text: [`${p}: ${t.language}, ${t.words.length} words.`, ...lines.slice(0, 600)].join(
            "\n",
          ),
        };
      },
    }),
    define({
      name: "plan_beats",
      description:
        "Cut a song into slots of exact length for a style: each slot is one shot, with its first frame, its length in frames, its energy, whether it is a downbeat, the drop or a hit, and suggested effects. Build the timeline with one clip per slot, frames exactly as given, so every cut lands on the beat.",
      input: z.object({
        music: path.describe("The song, as given to music"),
        style: z.enum(STYLES.map((x) => x.id) as [string, ...string[]]),
        fps: z.number().int().min(12).max(60).default(30),
        from: z.number().min(0).optional().describe("Start in the song, seconds"),
        to: z.number().min(0).optional().describe("End in the song, seconds"),
      }),
      readOnly: true,
      timeoutMs: 15 * 60_000,
      async run(engine, args) {
        const map = await engine.music(args.music);
        const slots = engine.plan(map, args.style, {
          fps: args.fps,
          ...(args.from !== undefined ? { from: args.from } : {}),
          ...(args.to !== undefined ? { to: args.to } : {}),
        });
        const total = slots.reduce((n, x) => n + x.frames, 0);
        const compact = slots.map((x) => ({
          i: x.index,
          frames: x.frames,
          t: Number(x.time.toFixed(3)),
          level: x.level,
          ...(x.downbeat ? { downbeat: true } : {}),
          ...(x.drop ? { drop: true } : {}),
          ...(x.hit ? { hit: true } : {}),
          ...(x.ramp ? { ramp: x.ramp } : {}),
          ...(x.effects.length ? { effects: x.effects } : {}),
        }));
        return {
          text: `${slots.length} slots, ${total} frames at ${args.fps} fps (${s(total / args.fps)} s), from ${s(args.from ?? 0)} s in the song. Set the timeline's music.from to that start.\n${JSON.stringify(compact)}`,
        };
      },
    }),
    define({
      name: "render",
      description:
        "Render a timeline to an .mp4: clips in order, each exactly its frames, with effects, grade, captions and music. Clips already rendered the same way are reused, so changing one clip is fast. Give formats to also export other shapes (9:16, 4:5, 1:1, 16:9). Never renders over a source.",
      input: z.object({
        ...renderTimelineArgs,
        output: path.describe("The .mp4 to write"),
        formats: z.array(formatNameSchema).max(4).optional(),
      }),
      readOnly: false,
      timeoutMs: 90 * 60_000,
      async run(engine, args) {
        const timeline = await timelineOf(args, read);
        const outputs: { output: string; t: Timeline }[] = [{ output: args.output, t: timeline }];
        for (const format of args.formats ?? []) {
          const size = FORMATS[format];
          if (size.width === timeline.output.width && size.height === timeline.output.height)
            continue;
          outputs.push({
            output: args.output.replace(/\.mp4$/, `-${format.replace(":", "x")}.mp4`),
            t: inFormat(timeline, format),
          });
        }
        const lines: string[] = [];
        for (const { output, t } of outputs) {
          const r = await engine.render(t, { output });
          lines.push(
            `Rendered ${r.output}: ${t.output.width}×${t.output.height}, ${t.output.fps} fps, ${r.frames} frames (${s(r.seconds)} s); ${r.rendered} of ${r.clips} clips rendered, the rest reused.`,
          );
        }
        return { text: lines.join("\n"), files: outputs.map((o) => o.output) };
      },
    }),
    define({
      name: "verify",
      description:
        "Check a render against its timeline before showing anyone: size, frame rate and length, that every cut is where it was planned (and on the beat, given the music), and that the sound is there and doesn't clip. Fix every problem and render again.",
      input: z.object({
        ...timelineArgs,
        output: path.describe("The rendered .mp4"),
        music: path.optional().describe("The song, to check cuts against its beats"),
      }),
      readOnly: true,
      timeoutMs: 30 * 60_000,
      async run(engine, args) {
        const timeline = await timelineOf(args, read);
        const map = args.music ? await engine.music(args.music) : undefined;
        const r = await engine.verify(timeline, args.output, map ? { music: map } : {});
        const offsets = r.cuts.beatOffsets;
        const worst = offsets?.length ? Math.max(...offsets.map(Math.abs)) : null;
        return {
          text: [
            r.ok ? "OK: no problems." : `Problems (${r.problems.length}):`,
            ...r.problems.map((p) => `- ${p}`),
            ...(r.warnings.length ? ["Warnings:", ...r.warnings.map((w) => `- ${w}`)] : []),
            `Output: ${r.output.width}×${r.output.height}, ${r.output.fps} fps, ${r.output.frames} frames, ${s(r.output.seconds)} s. Cuts: ${r.cuts.found} of ${r.cuts.planned} found${worst !== null ? `; furthest from a beat: ${worst} frames` : ""}. Sound: mean ${r.audio.meanDb ?? "?"} dB, peak ${r.audio.maxDb ?? "?"} dB.`,
          ].join("\n"),
        };
      },
    }),
    define({
      name: "contact_sheet",
      description:
        "Stills from a video at given times, tiled into one picture with each time printed on it: to compare takes, choose a shot, or check cuts (give a timeline instead of times for a still just before and just after each cut).",
      input: z.object({
        path,
        times: z.array(z.number().min(0)).min(1).max(24).optional(),
        ...timelineArgs,
        output: path.describe("The .jpg to write"),
      }),
      readOnly: false,
      timeoutMs: 15 * 60_000,
      async run(engine, args) {
        let times = args.times;
        if (!times) {
          const timeline =
            args.timeline || args.timeline_file ? await timelineOf(args, read) : null;
          if (!timeline) throw new Error("Give times, or a timeline to check its cuts");
          const fps = timeline.output.fps;
          let at = 0;
          const cuts: number[] = [];
          for (const clip of timeline.clips) {
            if (at > 0) cuts.push(at);
            at += clip.frames;
          }
          times = cuts.slice(0, 12).flatMap((c) => [Math.max(0, (c - 2) / fps), (c + 1) / fps]);
        }
        const r = await engine.sheet(args.path, times, { output: args.output });
        return {
          text: `Contact sheet ${r.output}: ${r.frames} stills at ${times.map(s).join(", ")} s.`,
          image: r.output,
          files: [r.output],
        };
      },
    }),
    define({
      name: "styles",
      description:
        "The edit styles and their rules: how each cuts to music, where effects go, the grade and captions. Read the style before planning an edit.",
      input: z.object({
        id: z.string().optional().describe("One style's id; left out, all of them briefly"),
      }),
      readOnly: true,
      timeoutMs: 10_000,
      async run(_engine, { id }) {
        if (!id) {
          return {
            text: STYLES.map((x) => `${x.id}: ${x.name}. ${x.description}`).join("\n"),
          };
        }
        const style = styleById(id);
        if (!style)
          throw new Error(`No style called ${id}; styles: ${STYLES.map((x) => x.id).join(", ")}`);
        return {
          text: [
            `${style.name} (${style.id}): ${style.description}`,
            style.beatsPerCut
              ? `Cuts every ${style.beatsPerCut.low} beats in low sections, ${style.beatsPerCut.mid} in mid, ${style.beatsPerCut.high} in high; shots at least ${style.minShotSeconds} s.`
              : `Cuts on speech, not beats; shots at least ${style.minShotSeconds} s.`,
            `Grade: ${style.grade}. Captions: ${style.captions ?? "none"}. Formats: ${style.formats.join(", ")}.`,
            "Rules:",
            ...style.rules.map((r) => `- ${r}`),
          ].join("\n"),
        };
      },
    }),
  ];
}
