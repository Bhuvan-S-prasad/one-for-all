import { collectRefs, parsePage, type PageMeta } from "./refs";

// The written pages (ADR-0051): Markdown in apps/learn/content, one folder per
// section, ordered by the number in each file name.

const files = import.meta.glob("../../content/*/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface Section {
  readonly key: string;
  readonly title: string;
  /** One line on the section's index page. */
  readonly intro: string;
  readonly pages: readonly PageMeta[];
}

const SECTION_INFO: Record<string, { title: string; intro: string }> = {
  path: {
    title: "Guided path",
    intro:
      "The repository chapter by chapter, from the big picture down to each subsystem. Read in order the first time.",
  },
  features: {
    title: "Features",
    intro:
      "One feature per page: what it does, its architecture and flow, the tables and endpoints behind it, and the functions that matter.",
  },
  walkthroughs: {
    title: "Walkthroughs",
    intro: "One action followed through every layer, with the real code at each stop.",
  },
};

const all: PageMeta[] = Object.entries(files).map(([path, text]) => {
  const [, section, file] = /content\/([^/]+)\/([^/]+)$/.exec(path) ?? [];
  return parsePage(section ?? "", file ?? path, text);
});

export const SECTIONS: readonly Section[] = ["path", "features", "walkthroughs"].map((key) => ({
  key,
  ...SECTION_INFO[key]!,
  pages: all
    .filter((p) => p.section === key)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
}));

export function findPage(section: string, slug: string): PageMeta | undefined {
  return SECTIONS.find((s) => s.key === section)?.pages.find((p) => p.slug === slug);
}

/** The pages before and after, within its section. */
export function neighbours(page: PageMeta): { prev?: PageMeta; next?: PageMeta } {
  const list = SECTIONS.find((s) => s.key === page.section)?.pages ?? [];
  const i = list.findIndex((p) => p.slug === page.slug);
  return { prev: list[i - 1], next: list[i + 1] };
}

/**
 * The written pages that point at each symbol or file (`path#Name` or `path`),
 * so a code page can say where it is explained.
 */
export const PAGES_BY_REF: ReadonlyMap<string, readonly PageMeta[]> = (() => {
  const map = new Map<string, PageMeta[]>();
  for (const page of all) {
    for (const r of collectRefs(page.body)) {
      if (r.kind !== "code" && r.kind !== "calls") continue;
      const list = map.get(r.ref) ?? map.set(r.ref, []).get(r.ref)!;
      if (!list.includes(page)) list.push(page);
    }
  }
  return map;
})();
