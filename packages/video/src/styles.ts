import type { Effect } from "./timeline";

// Styles as data (ADR-0049): how a kind of edit cuts, where its effects go,
// how it looks, and the editor's rules for it. The slot planner reads the
// numbers; the agent reads the rules. Every style here is a starting point
// the agent and the person can change, not a template that decides for them.

export type Energy = "low" | "mid" | "high";
export type SuggestedEffect = Omit<Effect, "at"> & { readonly at?: number };

export interface Style {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Beats per cut at each energy level; music-free styles cut on speech instead. */
  readonly beatsPerCut: Readonly<Record<Energy, number>> | null;
  /** Shortest shot, in seconds. */
  readonly minShotSeconds: number;
  /** On the first cut of a high section after a calmer one: the drop. */
  readonly drop: readonly SuggestedEffect[];
  /** On downbeats inside high sections. */
  readonly downbeat: readonly SuggestedEffect[];
  /** On the strongest beats (the top tenth by energy). */
  readonly hit: readonly SuggestedEffect[];
  /** Speed up through the shot before a drop, from 1 to this; null for none. */
  readonly rampIntoDrop: number | null;
  readonly grade: "none" | "punchy" | "teal_orange" | "warm" | "cold" | "faded" | "mono";
  readonly captions: "bold_center" | "bottom" | "karaoke" | null;
  readonly formats: readonly string[];
  /** The editor's rules, for the agent. */
  readonly rules: readonly string[];
}

export const STYLES: readonly Style[] = [
  {
    id: "amv",
    name: "AMV / velocity edit",
    description:
      "Anime or film clips cut tight to a song: fast cuts on the drop, action landing on the beat, speed ramps, flashes and shakes.",
    beatsPerCut: { low: 4, mid: 2, high: 1 },
    minShotSeconds: 0.25,
    drop: [
      { type: "flash", frames: 3, strength: 0.9 },
      { type: "zoom", frames: 6, strength: 0.6 },
    ],
    downbeat: [{ type: "zoom", frames: 4, strength: 0.35 }],
    hit: [{ type: "shake", frames: 5, strength: 0.5 }],
    rampIntoDrop: 2.5,
    grade: "punchy",
    captions: null,
    formats: ["16:9", "9:16"],
    rules: [
      "Save the strongest shot for the drop; never spend it in the intro.",
      "Land motion on the beat: start a shot just before its action peak so the peak hits the cut's beat.",
      "Cut mid-motion and keep the direction of movement across a cut (left to right stays left to right).",
      "Calm sections hold shots longer; match the mood of each section with the shots' energy.",
      "One character or idea per phrase of 4 or 8 beats; don't scatter.",
      "Effects only on the music's accents; an effect on every cut is noise.",
      "No subtitles or source logos in shots; skip shots with burned-in text.",
    ],
  },
  {
    id: "hype",
    name: "Hype montage",
    description:
      "A sports, gaming or event montage: builds slowly, explodes on the drop with fast cuts and punches.",
    beatsPerCut: { low: 4, mid: 2, high: 1 },
    minShotSeconds: 0.3,
    drop: [
      { type: "flash", frames: 2, strength: 1 },
      { type: "shake", frames: 8, strength: 0.7 },
    ],
    downbeat: [{ type: "zoom", frames: 4, strength: 0.4 }],
    hit: [{ type: "rgb_split", frames: 3, strength: 0.6 }],
    rampIntoDrop: 2,
    grade: "punchy",
    captions: null,
    formats: ["9:16", "16:9"],
    rules: [
      "Open on a hook in the first two seconds, then build.",
      "The best play or moment goes on the drop.",
      "Keep the speed rising section by section; the end is the biggest moment or a clean logo hold.",
    ],
  },
  {
    id: "cinematic_trailer",
    name: "Cinematic trailer",
    description:
      "A trailer or teaser: slow, wide shots and dialogue first, rising to quick cuts, then a title on black.",
    beatsPerCut: { low: 8, mid: 4, high: 2 },
    minShotSeconds: 0.5,
    drop: [{ type: "black", frames: 6, strength: 1 }],
    downbeat: [],
    hit: [{ type: "flash", frames: 2, strength: 0.7 }],
    rampIntoDrop: null,
    grade: "teal_orange",
    captions: "bottom",
    formats: ["16:9"],
    rules: [
      "Three acts: the world, the problem, the stakes; then the title.",
      "Lines of dialogue carry the story; let them breathe over calm music.",
      "Cut to black before the biggest hit; silence before the drop makes it land.",
      "Never give away the ending.",
    ],
  },
  {
    id: "talking_head",
    name: "Talking head for social",
    description:
      "A person speaking to camera, tightened for Reels, Shorts or TikTok: no pauses or retakes, bold captions, punch-ins.",
    beatsPerCut: null,
    minShotSeconds: 0.8,
    drop: [],
    downbeat: [],
    hit: [{ type: "zoom", frames: 8, strength: 0.25 }],
    rampIntoDrop: null,
    grade: "warm",
    captions: "karaoke",
    formats: ["9:16", "4:5", "1:1"],
    rules: [
      "Cut on words: remove pauses over half a second, filler words and retakes (keep the last good take).",
      "The first sentence is the hook; move the best line first if it stands alone.",
      "Punch in (zoom) every few sentences to keep it moving; never mid-word.",
      "Captions follow the words exactly, two or three words at a time.",
      "Music, if any, stays under the voice (about -18 dB).",
    ],
  },
  {
    id: "vlog",
    name: "Vlog",
    description:
      "Everyday footage with a story: moments in order, music under, natural sound kept.",
    beatsPerCut: { low: 8, mid: 4, high: 2 },
    minShotSeconds: 1,
    drop: [],
    downbeat: [],
    hit: [],
    rampIntoDrop: null,
    grade: "warm",
    captions: "bottom",
    formats: ["16:9", "9:16"],
    rules: [
      "Tell it in order unless the person asks otherwise; open with the best moment as a teaser.",
      "Keep natural sound where people talk or laugh; duck the music under it.",
      "Hold beautiful shots longer; cut boring parts short.",
    ],
  },
];

export function styleById(id: string): Style | undefined {
  return STYLES.find((s) => s.id === id);
}
