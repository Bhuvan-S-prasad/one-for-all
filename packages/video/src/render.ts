import type { Caption, Clip, Effect, Timeline } from "./timeline";
import { sourceSeconds, totalFrames } from "./timeline";

// Timeline to ffmpeg (ADR-0049). Each clip renders on its own to exactly its
// frame count (padding a short source with its last frame), so the joined
// edit is frame-exact and a changed clip renders again alone. The final pass
// joins the clips, grades, burns captions and mixes the music. Everything
// here builds argument lists; nothing runs a shell.

const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"];
const AUDIO_RATE = "48000";

/** Paths used inside a filter graph must not need escaping. */
export function safeFilterPath(path: string): string {
  if (!/^[\w./ -]+$/.test(path)) {
    throw new Error(`Rename ${path}: use letters, digits, spaces, dots, dashes and slashes only`);
  }
  return path;
}

const num = (n: number) => Number(n.toFixed(5)).toString();

/** The source-time to output-time map of a linear speed ramp, for `setpts`. */
function rampPts(clip: Clip, fps: number): string {
  const [s0, s1] = clip.ramp!;
  const duration = clip.frames / fps;
  const k = (s1 - s0) / duration;
  if (Math.abs(k) < 1e-6) return `setpts=(PTS-STARTPTS)/${num(s0)}`;
  // Output time t from source time T: T = s0·t + k·t²/2, solved for t.
  return `setpts='(-${num(s0)}+sqrt(${num(s0 * s0)}+${num(2 * k)}*(PTS-STARTPTS)*TB))/${num(k)}/TB'`;
}

const within = (e: Effect) => `between(n,${e.at},${e.at + e.frames - 1})`;

/** The filters for one clip's picture, in order. */
export function clipFilters(clip: Clip, output: Timeline["output"]): string[] {
  const { width: W, height: H, fps } = output;
  const filters: string[] = [];
  filters.push(clip.ramp ? rampPts(clip, fps) : `setpts=(PTS-STARTPTS)/${num(clip.speed)}`);
  filters.push(`fps=${fps}`);
  // Exactly the clip's frames: hold the last frame if the source runs out.
  filters.push(`tpad=stop_mode=clone:stop=${clip.frames}`);
  filters.push(`trim=end_frame=${clip.frames}`, "setpts=PTS-STARTPTS");

  const shakes = clip.effects.filter((e) => e.type === "shake");
  // A shake needs room to move: frame a little larger, then crop back.
  const margin = shakes.length ? 1 + 0.1 * Math.max(...shakes.map((e) => e.strength)) : 1;
  const w = Math.ceil((W * margin) / 2) * 2;
  const h = Math.ceil((H * margin) / 2) * 2;
  if (clip.fit === "cover") {
    const [fx, fy] = clip.focus;
    filters.push(
      `scale=${w}:${h}:force_original_aspect_ratio=increase`,
      `crop=${w}:${h}:(iw-${w})*${num(fx)}:(ih-${h})*${num(fy)}`,
    );
  } else {
    filters.push(
      `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
    );
  }
  if (shakes.length) {
    const amp = (e: Effect) => num(((w - W) / 2) * e.strength);
    const dx = shakes.map((e) => `${amp(e)}*sin(n*2.3)*${within(e)}`).join("+");
    const dy = shakes.map((e) => `${amp(e)}*cos(n*1.7)*${within(e)}`).join("+");
    filters.push(`crop=${W}:${H}:'(iw-ow)/2+${dx}':'(ih-oh)/2+${dy}'`);
  }
  filters.push("setsar=1");

  for (const e of clip.effects) {
    const end = e.at + e.frames;
    const fade = `(1-(n-${e.at})/${e.frames})`;
    switch (e.type) {
      case "flash":
        filters.push(
          `eq=eval=frame:brightness='if(between(n,${e.at},${end - 1}),${num(0.9 * e.strength)}*${fade},0)'`,
        );
        break;
      case "black":
        filters.push(
          `eq=eval=frame:brightness='if(between(n,${e.at},${end - 1}),-1,0)':contrast='if(between(n,${e.at},${end - 1}),0,1)'`,
        );
        break;
      case "zoom":
        filters.push(
          `zoompan=z='if(between(on,${e.at},${end - 1}),1+${num(0.35 * e.strength)}*(1-(on-${e.at})/${e.frames}),1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}`,
        );
        break;
      case "blur":
        filters.push(`gblur=sigma=${num(2 + 18 * e.strength)}:enable='${within(e)}'`);
        break;
      case "rgb_split": {
        const k = Math.round(4 + 16 * e.strength);
        filters.push(`rgbashift=rh=-${k}:bh=${k}:enable='${within(e)}'`);
        break;
      }
      case "shake":
        break;
    }
  }
  filters.push("format=yuv420p");
  return filters;
}

/** ffmpeg's `atempo` takes 0.5 to 2 per step; chain it for the rest. */
function tempoChain(speed: number): string[] {
  const steps: string[] = [];
  let left = speed;
  while (left > 2) {
    steps.push("atempo=2");
    left /= 2;
  }
  while (left < 0.5) {
    steps.push("atempo=0.5");
    left /= 0.5;
  }
  if (Math.abs(left - 1) > 1e-6) steps.push(`atempo=${num(left)}`);
  return steps;
}

/** One clip to its own file, exactly `clip.frames` long, with sound (silence unless it keeps its own). */
/** Threads for filters and the encoder; 0 lets ffmpeg use every core. */
function threadArgs(threads: number): string[] {
  return threads > 0
    ? ["-filter_complex_threads", String(threads), "-threads", String(threads)]
    : [];
}

export function clipCommand(
  clip: Clip,
  output: Timeline["output"],
  out: string,
  threads = 0,
): string[] {
  const seconds = clip.frames / output.fps;
  const read = sourceSeconds(clip, output.fps) + 1;
  const args = ["-v", "error", "-y", "-ss", num(clip.from), "-t", num(read), "-i", clip.src];
  args.push("-f", "lavfi", "-t", num(seconds), "-i", `anullsrc=r=${AUDIO_RATE}:cl=stereo`);
  const graph = [`[0:v]${clipFilters(clip, output).join(",")}[v]`];
  if (clip.audio !== undefined) {
    const chain = [
      "asetpts=PTS-STARTPTS",
      ...tempoChain(clip.speed),
      `volume=${num(clip.audio)}dB`,
      `aresample=${AUDIO_RATE}`,
      "aformat=channel_layouts=stereo",
      "apad",
      `atrim=end=${num(seconds)}`,
    ];
    graph.push(`[0:a]${chain.join(",")}[a]`);
  }
  args.push("-filter_complex", graph.join(";"), "-map", "[v]");
  args.push("-map", clip.audio !== undefined ? "[a]" : "1:a");
  args.push(
    ...ENCODE,
    ...threadArgs(threads),
    "-r",
    String(output.fps),
    "-frames:v",
    String(clip.frames),
  );
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", AUDIO_RATE, "-t", num(seconds), out);
  return args;
}

const GRADE_FILTERS: Record<Timeline["grade"]["preset"], string[]> = {
  none: [],
  punchy: ["eq=contrast=1.12:saturation=1.25", "unsharp=5:5:0.5"],
  teal_orange: ["colorbalance=rs=-0.08:bs=0.12:rh=0.1:bh=-0.1", "eq=contrast=1.08:saturation=1.1"],
  warm: ["colorbalance=rm=0.06:bm=-0.06", "eq=saturation=1.08"],
  cold: ["colorbalance=rm=-0.05:bm=0.08", "eq=saturation=0.95"],
  faded: ["eq=contrast=0.88:brightness=0.03:saturation=0.85"],
  mono: ["hue=s=0", "eq=contrast=1.1"],
};

/** Join the clips, grade, burn captions and mix the music. */
export function finalCommand(
  timeline: Timeline,
  files: { readonly list: string; readonly captions?: string; readonly out: string },
  threads = 0,
): string[] {
  const frames = totalFrames(timeline);
  const seconds = frames / timeline.output.fps;
  const args = ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", files.list];
  if (timeline.music) {
    args.push("-ss", num(timeline.music.from), "-t", num(seconds), "-i", timeline.music.src);
  }
  const video = [...GRADE_FILTERS[timeline.grade.preset]];
  if (timeline.grade.lut) video.push(`lut3d=file='${safeFilterPath(timeline.grade.lut)}'`);
  if (files.captions) video.push(`subtitles=filename='${safeFilterPath(files.captions)}'`);
  video.push("format=yuv420p");
  const graph = [`[0:v]${video.join(",")}[v]`];
  if (timeline.music) {
    const { gain, fadeOut } = timeline.music;
    const fade =
      fadeOut > 0 ? `,afade=t=out:st=${num(Math.max(0, seconds - fadeOut))}:d=${num(fadeOut)}` : "";
    graph.push(
      `[1:a]asetpts=PTS-STARTPTS,aresample=${AUDIO_RATE},aformat=channel_layouts=stereo,volume=${num(gain)}dB,apad,atrim=end=${num(seconds)}${fade}[m]`,
      `[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`,
    );
  }
  args.push("-filter_complex", graph.join(";"), "-map", "[v]");
  args.push("-map", timeline.music ? "[a]" : "0:a");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p");
  args.push(...threadArgs(threads));
  args.push("-r", String(timeline.output.fps), "-frames:v", String(frames));
  args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", files.out);
  return args;
}

/** The concat list for the clips' files. */
export function concatList(files: readonly string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Burned captions as an ASS file: sizes from the frame, so they read on a phone. */
export function captionsAss(
  lines: readonly Caption[],
  style: "bold_center" | "bottom" | "karaoke",
  output: Timeline["output"],
): string {
  const { width: W, height: H } = output;
  const small = Math.min(W, H);
  const size = Math.round(style === "bottom" ? small * 0.05 : small * 0.075);
  const bold = style === "bottom" ? 0 : -1;
  // Colours are &HAABBGGRR: white, or yellow for karaoke.
  const colour = style === "karaoke" ? "&H0000E5FF" : "&H00FFFFFF";
  const marginV = Math.round(style === "bottom" ? H * 0.06 : H * 0.22);
  const outline = Math.max(2, Math.round(size / 12));
  const text = (t: string) => {
    const clean = t
      .replace(/[{}\\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return style === "karaoke" ? clean.toUpperCase() : clean;
  };
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,DejaVu Sans,${size},${colour},${colour},&H00000000,&H80000000,${bold},0,0,0,100,100,0,0,1,${outline},0,2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines
      .filter((l) => l.end > l.start)
      .map(
        (l) => `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Default,,0,0,0,,${text(l.text)}`,
      ),
    "",
  ].join("\n");
}
