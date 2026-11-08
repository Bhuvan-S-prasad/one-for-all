import type { Caption, Timeline } from "./timeline";
import { cutFrames } from "./timeline";

// Captions from what is said (ADR-0049): the words of each clip's own sound,
// moved to where the clip sits in the edit, a few words at a time. A clip
// that is silent in the edit has no captions.

export interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function speechCaptions(
  timeline: Timeline,
  words: (src: string) => readonly Word[],
  wordsPerLine = 3,
): Caption[] {
  const { fps } = timeline.output;
  const starts = cutFrames(timeline);
  const lines: Caption[] = [];
  timeline.clips.forEach((clip, i) => {
    if (clip.audio === undefined || clip.ramp) return;
    const outStart = starts[i]! / fps;
    const outEnd = (starts[i]! + clip.frames) / fps;
    const srcEnd = clip.from + (clip.frames / fps) * clip.speed;
    const inside = words(clip.src).filter((w) => w.start >= clip.from && w.end <= srcEnd + 0.05);
    for (let k = 0; k < inside.length; k += wordsPerLine) {
      const group = inside.slice(k, k + wordsPerLine);
      const at = (t: number) => outStart + (t - clip.from) / clip.speed;
      const start = Math.max(outStart, at(group[0]!.start));
      const end = Math.min(outEnd, at(group[group.length - 1]!.end));
      if (end > start) {
        lines.push({ text: group.map((w) => w.text).join(" "), start, end });
      }
    }
  });
  return lines;
}
