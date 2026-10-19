import { createHash } from "node:crypto";
import { beatOffsets, musicMapSchema, planSlots, type MusicMap, type Slot } from "./music";
import {
  parseProbe,
  parseSceneMetadata,
  parseVolume,
  shotsFrom,
  type MediaInfo,
  type Shot,
} from "./parse";
import { speechCaptions } from "./captions";
import { captionsAss, clipCommand, concatList, finalCommand, safeFilterPath } from "./render";
import type { Runner } from "./runner";
import { MUSIC_PY, SCRIPTS_VERSION, TRANSCRIBE_PY } from "./scripts";
import { styleById } from "./styles";
import {
  cutFrames,
  timelineSchema,
  totalFrames,
  type Timeline,
  type TimelineInput,
} from "./timeline";

// The video engine (ADR-0049): analysis, rendering and checks over a Runner.
// It never decides what the edit says; it measures, renders exactly what the
// timeline says, and reports what it finds.

/** Bump when rendering changes, so kept clips render again. */
const RENDER_VERSION = 1;

export class VideoError extends Error {
  override readonly name = "VideoError";
  constructor(
    readonly code: "bad_input" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface VideoEngineOptions {
  readonly runner: Runner;
  /** Scripts, rendered clips and edit files; `~/` is the runner's home. Default `~/.ofa-video`. */
  readonly workDir?: string;
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  /** Default: OFA_VIDEO_PYTHON where the commands run, else `python3`. */
  readonly python?: string;
  /**
   * Threads ffmpeg may use; by default all cores. x264 sizes its buffers by
   * thread count, so a computer shared with browsers caps it (One-for-All: 2).
   */
  readonly threads?: number;
}

export interface Scan {
  readonly info: MediaInfo;
  readonly shots: readonly Shot[];
}

export interface Transcript {
  readonly language: string;
  readonly duration: number;
  readonly words: readonly {
    readonly text: string;
    readonly start: number;
    readonly end: number;
  }[];
}

export interface RenderResult {
  readonly output: string;
  readonly frames: number;
  readonly seconds: number;
  readonly clips: number;
  /** Clips rendered this time; the rest were kept from an earlier render. */
  readonly rendered: number;
}

export interface VerifyReport {
  /** No problems; warnings may remain. */
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
  readonly output: {
    readonly width: number | null;
    readonly height: number | null;
    readonly fps: number | null;
    readonly frames: number | null;
    readonly seconds: number;
  };
  readonly cuts: {
    readonly planned: number;
    /** Planned cuts the output shows within the tolerance. */
    readonly found: number;
    /** Each planned cut's distance from the nearest beat, in frames, when the music map was given. */
    readonly beatOffsets?: readonly number[];
  };
  readonly audio: { readonly meanDb: number | null; readonly maxDb: number | null };
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);

/** A caption's words, lower case, for comparing. */
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

const tail = (text: string) => text.trim().split("\n").slice(-12).join("\n").slice(-1_500);

export function createVideoEngine(options: VideoEngineOptions) {
  const { runner } = options;
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffprobe = options.ffprobe ?? "ffprobe";
  let home: string | undefined;
  let scriptsReady = false;

  async function resolve(path: string): Promise<string> {
    if (path !== "~" && !path.startsWith("~/")) return path;
    home ??= (await runner.env("HOME")) ?? "";
    if (!home) throw new VideoError("failed", "No home folder to resolve ~ in");
    return home + path.slice(1);
  }
  const work = () => resolve(options.workDir ?? "~/.ofa-video");

  async function exec(argv: string[], timeoutMs: number, what: string): Promise<string> {
    const result = await runner.run(argv, { timeoutMs });
    if (result.code !== 0) {
      throw new VideoError("failed", `${what} failed: ${tail(result.stderr || result.stdout)}`);
    }
    return result.stdout;
  }
  const mkdir = async (dir: string) => {
    await exec(["mkdir", "-p", "--", dir], 30_000, "Making a folder");
  };
  const exists = async (path: string) =>
    (await runner.run(["test", "-s", path], { timeoutMs: 30_000 })).code === 0;

  /** Size and change time: a file replaced under the same name is analysed again. */
  const stamp = async (src: string) =>
    (await exec(["stat", "-L", "-c", "%s-%Y", "--", src], 30_000, `Reading ${src}`)).trim();

  /** Scene detection, printed to a file: long footage prints more than a command's output may hold. */
  async function scenes(src: string, filters: string, what: string): Promise<string> {
    const dir = `${await work()}/analysis`;
    await mkdir(dir);
    const file = safeFilterPath(`${dir}/scenes-${hash([src, filters, Date.now()])}.txt`);
    await exec(
      [
        ffmpeg,
        "-v",
        "error",
        "-i",
        src,
        "-an",
        "-vf",
        `${filters},metadata=print:file=${file}`,
        "-f",
        "null",
        "-",
      ],
      20 * 60_000,
      what,
    );
    const text = new TextDecoder().decode(await runner.readFile(file));
    await runner.run(["rm", "-f", "--", file], { timeoutMs: 30_000 });
    return text;
  }

  async function python(): Promise<string> {
    return options.python ?? (await runner.env("OFA_VIDEO_PYTHON")) ?? "python3";
  }

  async function scripts(): Promise<{ music: string; transcribe: string }> {
    const dir = `${await work()}/bin`;
    const paths = {
      music: `${dir}/music-v${SCRIPTS_VERSION}.py`,
      transcribe: `${dir}/transcribe-v${SCRIPTS_VERSION}.py`,
    };
    if (!scriptsReady) {
      await mkdir(dir);
      await runner.writeFile(paths.music, MUSIC_PY);
      await runner.writeFile(paths.transcribe, TRANSCRIBE_PY);
      scriptsReady = true;
    }
    return paths;
  }

  async function readJson(path: string): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(await runner.readFile(path)));
  }

  async function probe(path: string): Promise<MediaInfo> {
    const src = await resolve(path);
    const out = await exec(
      [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", src],
      60_000,
      `Reading ${path}`,
    );
    return parseProbe(out);
  }

  const engine = {
    probe,

    /** Write a text file (a timeline) where the media is; `~/` is the runner's home. */
    async write(path: string, text: string): Promise<string> {
      const target = await resolve(path);
      const slash = target.lastIndexOf("/");
      if (slash > 0) await mkdir(target.slice(0, slash));
      await runner.writeFile(target, text);
      return path;
    },

    /** Shots and how much each moves, from scene detection on a small, slowed copy. */
    async scan(path: string, opts: { readonly threshold?: number } = {}): Promise<Scan> {
      const info = await probe(path);
      if (!info.hasVideo) throw new VideoError("bad_input", `${path} has no picture`);
      const src = await resolve(path);
      const threshold = opts.threshold ?? 10;
      const out = await scenes(
        src,
        `fps=5,scale=160:-2,scdet=threshold=${threshold}`,
        `Scanning ${path}`,
      );
      return { info, shots: shotsFrom(parseSceneMetadata(out), info.duration, threshold) };
    },

    /** Beats, downbeats, energy and sections of a song (or any file's sound). */
    /** Beats and sections of a song. `bpm`: its real tempo, when known, so the tracker can't lock onto 2/3 of it. */
    async music(path: string, opts: { readonly bpm?: number } = {}): Promise<MusicMap> {
      const src = await resolve(path);
      const { music } = await scripts();
      const out = `${await work()}/analysis/music-${hash([src, await stamp(src), opts.bpm ?? null, SCRIPTS_VERSION])}.json`;
      await mkdir(`${await work()}/analysis`);
      if (!(await exists(out)))
        await exec(
          [await python(), music, src, out, opts.bpm === undefined ? "" : String(opts.bpm)],
          15 * 60_000,
          `Analysing the music in ${path}`,
        );
      return musicMapSchema.parse(await readJson(out));
    },

    /** Every spoken word with its time. */
    async transcribe(path: string, opts: { readonly language?: string } = {}): Promise<Transcript> {
      const src = await resolve(path);
      const { transcribe } = await scripts();
      const out = `${await work()}/analysis/words-${hash([src, await stamp(src), opts.language, SCRIPTS_VERSION])}.json`;
      await mkdir(`${await work()}/analysis`);
      if (!(await exists(out)))
        await exec(
          [await python(), transcribe, src, out, opts.language ?? ""],
          60 * 60_000,
          `Transcribing ${path}`,
        );
      return (await readJson(out)) as Transcript;
    },

    /** Slots of exact length for a style over a music map. */
    plan(
      map: MusicMap,
      styleId: string,
      opts: { fps: number; from?: number; to?: number },
    ): Slot[] {
      const style = styleById(styleId);
      if (!style) throw new VideoError("bad_input", `No style called ${styleId}`);
      return planSlots(map, style, opts);
    },

    /** Render a timeline to `output`. Clips already rendered the same way are kept. */
    async render(input: TimelineInput, opts: { readonly output: string }): Promise<RenderResult> {
      const parsed = timelineSchema.safeParse(input);
      if (!parsed.success) {
        throw new VideoError("bad_input", `The timeline doesn't fit: ${parsed.error.message}`);
      }
      const timeline: Timeline = parsed.data;
      if (!opts.output.endsWith(".mp4"))
        throw new VideoError("bad_input", "Render to an .mp4 file");
      const output = await resolve(opts.output);
      const sources = await Promise.all(
        [...timeline.clips.map((c) => c.src), ...(timeline.music ? [timeline.music.src] : [])].map(
          resolve,
        ),
      );
      if (sources.includes(output)) {
        throw new VideoError("bad_input", "Never render over a source; pick a new file name");
      }
      const resolved: Timeline = {
        ...timeline,
        clips: await Promise.all(
          timeline.clips.map(async (c) => ({ ...c, src: await resolve(c.src) })),
        ),
        ...(timeline.music
          ? { music: { ...timeline.music, src: await resolve(timeline.music.src) } }
          : {}),
        grade: {
          ...timeline.grade,
          ...(timeline.grade.lut ? { lut: await resolve(timeline.grade.lut) } : {}),
        },
      };

      const root = await work();
      const clipsDir = `${root}/clips`;
      const editDir = `${root}/edits/${hash([resolved, RENDER_VERSION])}`;
      await mkdir(clipsDir);
      await mkdir(editDir);
      const files: string[] = [];
      let rendered = 0;
      for (const clip of resolved.clips) {
        const file = `${clipsDir}/${hash([clip, await stamp(clip.src), resolved.output, RENDER_VERSION])}.mp4`;
        if (!(await exists(file))) {
          const part = `${file}.part.mp4`;
          await exec(
            [ffmpeg, ...clipCommand(clip, resolved.output, part, options.threads)],
            20 * 60_000,
            `Rendering the clip from ${clip.src} at ${clip.from}s`,
          );
          await exec(["mv", "-f", "--", part, file], 30_000, "Keeping a clip");
          rendered += 1;
        }
        files.push(file);
      }
      const list = `${editDir}/clips.txt`;
      await runner.writeFile(list, concatList(files));
      let captions: string | undefined;
      const lines = [...(resolved.captions?.lines ?? [])];
      if (
        resolved.captions?.fromSpeech &&
        !resolved.clips.some((c) => c.audio !== undefined && !c.ramp)
      ) {
        throw new VideoError(
          "bad_input",
          "Captions from speech need clips that keep their sound: give those clips audio: 0",
        );
      }
      if (resolved.captions?.fromSpeech) {
        const spoken = new Map<string, Transcript["words"]>();
        for (const clip of resolved.clips) {
          if (clip.audio !== undefined && !spoken.has(clip.src)) {
            spoken.set(clip.src, (await engine.transcribe(clip.src)).words);
          }
        }
        const speech = speechCaptions(
          resolved,
          (src) => spoken.get(src) ?? [],
          resolved.captions.wordsPerLine,
        );
        // Written lines are for titles; one that repeats what is said would show twice.
        const said = new Set(speech.flatMap((l) => words(l.text)));
        const extra = lines.filter((l) => !words(l.text).every((w) => said.has(w)));
        lines.splice(0, lines.length, ...extra, ...speech);
        lines.sort((a, b) => a.start - b.start);
      }
      if (resolved.captions && lines.length) {
        captions = `${editDir}/captions.ass`;
        await runner.writeFile(
          captions,
          captionsAss(lines, resolved.captions.style, resolved.output),
        );
      }
      const slash = output.lastIndexOf("/");
      if (slash > 0) await mkdir(output.slice(0, slash));
      await exec(
        [
          ffmpeg,
          ...finalCommand(
            resolved,
            { list, out: output, ...(captions ? { captions } : {}) },
            options.threads,
          ),
        ],
        60 * 60_000,
        "Joining the edit",
      );
      const frames = totalFrames(resolved);
      return {
        output: opts.output,
        frames,
        seconds: frames / resolved.output.fps,
        clips: files.length,
        rendered,
      };
    },

    /** Check a render against its timeline: size, length, cuts, beats and sound. */
    async verify(
      input: TimelineInput,
      path: string,
      opts: { readonly music?: MusicMap; readonly toleranceFrames?: number } = {},
    ): Promise<VerifyReport> {
      const timeline = timelineSchema.parse(input);
      const tolerance = opts.toleranceFrames ?? 1;
      const problems: string[] = [];
      const warnings: string[] = [];
      const info = await probe(path);
      const src = await resolve(path);
      const { width, height, fps } = timeline.output;
      const expected = totalFrames(timeline);
      if (info.width !== width || info.height !== height) {
        problems.push(`The output is ${info.width}×${info.height}, not ${width}×${height}`);
      }
      if (info.fps !== null && Math.abs(info.fps - fps) > 0.01) {
        problems.push(`The output runs at ${info.fps} fps, not ${fps}`);
      }
      const frames = info.frames ?? Math.round(info.duration * fps);
      if (Math.abs(frames - expected) > tolerance) {
        problems.push(`The output has ${frames} frames; the timeline has ${expected}`);
      }

      const scene = parseSceneMetadata(
        await scenes(src, "scale=320:-2,scdet=threshold=8", "Finding the cuts in the output"),
      );
      const detected = scene.filter((s) => s.score >= 8).map((s) => s.frame);
      const planned = cutFrames(timeline).slice(1);
      const found = planned.filter((c) =>
        detected.some((d) => Math.abs(d - c) <= tolerance),
      ).length;
      if (found < planned.length) {
        warnings.push(
          `${planned.length - found} of ${planned.length} cuts don't show as a scene change (similar shots on both sides, or a cut out of place); look at them on a contact sheet`,
        );
      }
      const offsets = opts.music
        ? beatOffsets(planned, opts.music, { fps, from: timeline.music?.from ?? 0 })
        : undefined;
      if (offsets) {
        const off = offsets.filter((o) => Math.abs(o) > tolerance).length;
        if (off) warnings.push(`${off} cuts are more than ${tolerance} frame off the nearest beat`);
      }

      const volume = parseVolume(
        (
          await runner.run(
            [ffmpeg, "-hide_banner", "-i", src, "-vn", "-af", "volumedetect", "-f", "null", "-"],
            { timeoutMs: 20 * 60_000 },
          )
        ).stderr,
      );
      const expectsSound = !!timeline.music || timeline.clips.some((c) => c.audio !== undefined);
      if (!info.hasAudio) problems.push("The output has no sound track");
      else if (expectsSound && (volume.mean === null || volume.mean < -60)) {
        problems.push("The output is silent");
      }
      if (volume.max !== null && volume.max >= 0) {
        warnings.push("The sound peaks at 0 dB and may clip; lower the music or clip gain");
      }
      return {
        ok: problems.length === 0,
        problems,
        warnings,
        output: {
          width: info.width,
          height: info.height,
          fps: info.fps,
          frames,
          seconds: info.duration,
        },
        cuts: { planned: planned.length, found, ...(offsets ? { beatOffsets: offsets } : {}) },
        audio: { meanDb: volume.mean, maxDb: volume.max },
      };
    },

    /** Stills at the given times, tiled into one picture with each time on it. */
    async sheet(
      path: string,
      times: readonly number[],
      opts: { readonly output: string; readonly columns?: number; readonly width?: number },
    ): Promise<{ readonly output: string; readonly frames: number }> {
      if (times.length === 0 || times.length > 24) {
        throw new VideoError("bad_input", "Give 1 to 24 times for a contact sheet");
      }
      const src = await resolve(path);
      const width = opts.width ?? 320;
      const dir = `${await work()}/sheets/${hash([src, times, width])}`;
      await mkdir(dir);
      for (const [i, t] of times.entries()) {
        await exec(
          [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-ss",
            String(Math.max(0, t)),
            "-i",
            src,
            "-frames:v",
            "1",
            "-vf",
            `scale=${width}:-2,drawtext=font='DejaVu Sans':text='${t.toFixed(2)}s':x=6:y=6:fontsize=${Math.round(width / 14)}:fontcolor=white:box=1:boxcolor=black@0.6`,
            `${dir}/${String(i).padStart(2, "0")}.jpg`,
          ],
          5 * 60_000,
          `Taking a still at ${t}s`,
        );
      }
      const columns = Math.min(opts.columns ?? 4, times.length);
      const rows = Math.ceil(times.length / columns);
      const output = await resolve(opts.output);
      const slash = output.lastIndexOf("/");
      if (slash > 0) await mkdir(output.slice(0, slash));
      await exec(
        [
          ffmpeg,
          "-v",
          "error",
          "-y",
          "-framerate",
          "1",
          "-i",
          `${dir}/%02d.jpg`,
          "-vf",
          `tile=${columns}x${rows}:padding=4:color=black`,
          "-frames:v",
          "1",
          output,
        ],
        5 * 60_000,
        "Making the contact sheet",
      );
      return { output: opts.output, frames: times.length };
    },
  };
  return engine;
}

export type VideoEngine = ReturnType<typeof createVideoEngine>;
