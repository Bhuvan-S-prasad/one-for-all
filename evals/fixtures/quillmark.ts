import { page, type WebFixture } from "./web";

// Quillmark is a made-up note-taking method spread over four long pages, so a
// task that reads them all fills a small context window and forces a
// compaction mid-task (UX.01). Each page holds one fact the report must keep;
// the rest is filler that only costs tokens.

const BASE = "https://quillmark.example.org/guide";
export const QUILLMARK_PAGES = {
  overview: `${BASE}/overview`,
  capture: `${BASE}/capture`,
  distil: `${BASE}/distil`,
  review: `${BASE}/review`,
} as const;

/** Paragraphs that read like a guide but carry no facts the checks look for. */
function filler(topic: string, count: number): string[] {
  const lines = [
    `Teams that try ${topic} for the first time often start too big; the guide recommends one notebook and one week before adding anything else.`,
    `Most of the questions people ask about ${topic} come down to habit rather than tools, so the examples here use plain text on purpose.`,
    `If ${topic} feels slow at first, that is expected: the point is to make later work faster, not today's.`,
    `The community forum collects worked examples of ${topic} from writers, engineers and students, and none of them use the same setup.`,
    `A common mistake with ${topic} is copying someone else's system wholesale instead of keeping the few parts that fit how you already work.`,
    `There is no app required for ${topic}; paper works, and so does any editor that can search across files.`,
    `People who stick with ${topic} for a month usually change one rule to suit themselves, and the guide encourages that.`,
    `The original authors describe ${topic} as a set of defaults, not a doctrine, and revise these pages every season.`,
  ];
  return Array.from({ length: count }, (_, n) => lines[n % lines.length] as string);
}

export const quillmarkWeb: WebFixture = {
  searches: [
    {
      match: ["quillmark"],
      results: [
        {
          title: "Quillmark guide: overview",
          url: QUILLMARK_PAGES.overview,
          snippet: "What Quillmark is and the three stages: capture, distil, review.",
        },
        {
          title: "Quillmark guide: capture",
          url: QUILLMARK_PAGES.capture,
          snippet: "The first stage of Quillmark.",
        },
        {
          title: "Quillmark guide: distil",
          url: QUILLMARK_PAGES.distil,
          snippet: "The second stage of Quillmark.",
        },
        {
          title: "Quillmark guide: review",
          url: QUILLMARK_PAGES.review,
          snippet: "The third stage of Quillmark.",
        },
      ],
    },
  ],
  pages: {
    [QUILLMARK_PAGES.overview]: page(
      "Quillmark guide: overview",
      "Quillmark is a note-taking method in three stages: capture, distil and review. It was first published by the Fenwick reading group.",
      ...filler("Quillmark", 46),
    ),
    [QUILLMARK_PAGES.capture]: page(
      "Quillmark guide: capture",
      "The capture rule: anything you write down must be filed within 48 hours, or it is deleted.",
      ...filler("capturing notes", 46),
    ),
    [QUILLMARK_PAGES.distil]: page(
      "Quillmark guide: distil",
      "The distil rule: every note is cut down to at most three sentences in your own words.",
      ...filler("distilling notes", 46),
    ),
    [QUILLMARK_PAGES.review]: page(
      "Quillmark guide: review",
      "The review rule: distilled notes are reread every Friday, and anything unused for a month is archived.",
      ...filler("reviewing notes", 46),
    ),
  },
};
