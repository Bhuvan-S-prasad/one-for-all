// How written pages point at the code (ADR-0051). The same rules are used by
// the index script, which fails the build on a reference that doesn't
// resolve, and by the app, which renders it. Pure functions, no DOM.
//
// In Markdown links:
//   [runAgent](code:packages/harness/src/loop.ts#runAgent)   a symbol
//   [the loop](code:packages/harness/src/loop.ts)            a file
//   [thread](table:thread)                                   a database table
//   [send](api:POST:/api/threads/:id/messages)               an endpoint
//   [ADR-0050](adr:0050)                                     a decision
//   [Teams](page:features/teams)                             a written page
//   [harness](pkg:harness)                                   a package
//
// As fenced blocks (one reference per block):
//   ```code        a symbol or a file; optional `from:` and `to:` lines narrow
//                  it to the lines between two pieces of its text
//   ```calls       a symbol's callers and callees
//   ```table       a table's columns
//   ```endpoints   the endpoints whose path starts with this prefix

export type RefKind = "code" | "table" | "api" | "adr" | "page" | "pkg";

export const LINK_SCHEMES: readonly RefKind[] = ["code", "table", "api", "adr", "page", "pkg"];

export const REF_BLOCKS = ["code", "calls", "table", "endpoints"] as const;
export type RefBlock = (typeof REF_BLOCKS)[number];

export interface PageMeta {
  /** `path`, `features` or `walkthroughs`. */
  readonly section: string;
  /** `01-big-picture` → slug `big-picture`, order 1. */
  readonly slug: string;
  readonly order: number;
  readonly title: string;
  readonly summary: string;
  /** The Markdown after the front matter. */
  readonly body: string;
}

/**
 * A content file: `---`, `title:` and `summary:` lines, `---`, then Markdown.
 * `file` is its name in its section folder, e.g. `01-big-picture.md`.
 */
export function parsePage(section: string, file: string, text: string): PageMeta {
  const name = file.replace(/\.md$/, "");
  const numbered = /^(\d+)-(.+)$/.exec(name);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const head = match?.[1] ?? "";
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head)?.[1]?.trim() ?? "";
  return {
    section,
    slug: numbered ? numbered[2]! : name,
    order: numbered ? Number(numbered[1]) : 999,
    title: field("title") || name,
    summary: field("summary"),
    body: match ? text.slice(match[0].length) : text,
  };
}

/** `path#Name` → its parts; a bare path is a file. */
export function splitCodeRef(ref: string): { path: string; symbol: string | null } {
  const at = ref.indexOf("#");
  return at < 0
    ? { path: ref, symbol: null }
    : { path: ref.slice(0, at), symbol: ref.slice(at + 1) };
}

/** `POST:/api/threads/:id/messages` → its parts. */
export function splitApiRef(ref: string): { method: string; path: string } {
  const at = ref.indexOf(":");
  return { method: ref.slice(0, at).toUpperCase(), path: ref.slice(at + 1) };
}

export interface BlockRef {
  readonly ref: string;
  readonly from: string | null;
  readonly to: string | null;
  /** A caption above the excerpt. */
  readonly title: string | null;
}

/** The body of a reference block: the reference, then optional `from:`, `to:`, `title:` lines. */
export function parseBlockRef(body: string): BlockRef {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const ref = lines.find((l) => l && !/^(from|to|title):/.test(l)) ?? "";
  const field = (key: string) => {
    const line = lines.find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : null;
  };
  return { ref, from: field("from"), to: field("to"), title: field("title") };
}

/**
 * The 1-based lines `[start, end]` of `text` between the line holding `from`
 * and the next line holding `to` (both kept), searched from `start`. Null when
 * an anchor isn't found.
 */
export function narrow(
  text: string,
  start: number,
  end: number,
  from: string | null,
  to: string | null,
): { start: number; end: number } | null {
  const lines = text.split("\n");
  let first = start;
  if (from) {
    const at = lines.slice(start - 1, end).findIndex((l) => l.includes(from));
    if (at < 0) return null;
    first = start + at;
  }
  let last = end;
  if (to) {
    const at = lines.slice(first - 1, end).findIndex((l) => l.includes(to));
    if (at < 0) return null;
    last = first + at;
  }
  return { start: first, end: last };
}

/** Every reference in a page's Markdown, with where it was found, for checking. */
export function collectRefs(
  markdown: string,
): { kind: RefKind | RefBlock; ref: string; from: string | null; to: string | null }[] {
  const found: { kind: RefKind | RefBlock; ref: string; from: string | null; to: string | null }[] =
    [];
  const fence = /^```(\w+)[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of markdown.matchAll(fence)) {
    const lang = m[1] as RefBlock;
    if (!REF_BLOCKS.includes(lang)) continue;
    const block = parseBlockRef(m[2] ?? "");
    found.push({ kind: lang, ref: block.ref, from: block.from, to: block.to });
  }
  // Links outside fenced blocks.
  const prose = markdown.replace(fence, "");
  const link = /\]\((code|table|api|adr|page|pkg):([^)\s]+)\)/g;
  for (const m of prose.matchAll(link)) {
    found.push({ kind: m[1] as RefKind, ref: m[2]!, from: null, to: null });
  }
  return found;
}
