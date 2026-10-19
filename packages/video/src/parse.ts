// Reading what ffprobe and ffmpeg print (ADR-0049).

export interface MediaInfo {
  readonly duration: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly frames: number | null;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

function rate(value: string | undefined): number | null {
  if (!value) return null;
  const [a, b] = value.split("/").map(Number);
  if (!a || !b) return null;
  return Math.round((a / b) * 1000) / 1000;
}

/** `ffprobe -print_format json -show_format -show_streams`. */
export function parseProbe(json: string): MediaInfo {
  const data = JSON.parse(json) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  // Cover art in a music file is a "video" stream; it isn't footage.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const frames = video?.nb_frames ? Number(video.nb_frames) : null;
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
    frames: frames !== null && Number.isFinite(frames) ? frames : null,
    hasAudio: !!audio,
    hasVideo: !!video,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

export interface SceneSample {
  readonly frame: number;
  readonly time: number;
  /** Mean absolute difference from the previous frame: how much moves. */
  readonly motion: number;
  /** Scene-change score, 0 to 100. */
  readonly score: number;
}

/** `scdet` with `metadata=print`: one block per frame. */
export function parseSceneMetadata(text: string): SceneSample[] {
  const samples: SceneSample[] = [];
  let current: { frame: number; time: number; motion: number; score: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)/.exec(line);
    if (head) {
      if (current) samples.push(current);
      current = { frame: Number(head[1]), time: Number(head[2]), motion: 0, score: 0 };
      continue;
    }
    const kv = /^lavfi\.scd\.(mafd|score)=([\d.]+)/.exec(line.trim());
    if (kv && current) {
      if (kv[1] === "mafd") current.motion = Number(kv[2]);
      else current.score = Number(kv[2]);
    }
  }
  if (current) samples.push(current);
  return samples;
}

export interface Shot {
  readonly start: number;
  readonly end: number;
  /** Mean motion through the shot. */
  readonly motion: number;
  /** When it moves most. */
  readonly peak: number;
}

/** Shots between scene changes, with how much each moves and when it peaks. */
export function shotsFrom(
  samples: readonly SceneSample[],
  duration: number,
  threshold = 10,
): Shot[] {
  const cuts = [0, ...samples.filter((s) => s.score >= threshold && s.time > 0).map((s) => s.time)];
  return cuts.map((start, i) => {
    const end = cuts[i + 1] ?? duration;
    const inside = samples.filter((s) => s.time >= start && s.time < end && s.score < threshold);
    const motion = inside.length ? inside.reduce((a, s) => a + s.motion, 0) / inside.length : 0;
    const peak = inside.reduce((best, s) => (s.motion > best.motion ? s : best), {
      time: start,
      motion: -1,
    } as { time: number; motion: number }).time;
    return {
      start: round(start),
      end: round(end),
      motion: round(motion),
      peak: round(peak),
    };
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** `volumedetect`'s mean and peak loudness, in dB. */
export function parseVolume(text: string): { mean: number | null; max: number | null } {
  const mean = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(text)?.[1];
  const max = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(text)?.[1];
  const value = (v: string | undefined) =>
    v === undefined ? null : v === "-inf" ? -Infinity : Number(v);
  return { mean: value(mean), max: value(max) };
}
