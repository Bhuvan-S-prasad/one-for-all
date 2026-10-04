// A small Markdown parser for agent replies (UX.08). It returns a tree that
// React renders as text, so a reply can never inject HTML: raw tags show as
// typed, and links keep only http, https and mailto addresses.
//
// Supported: headings, paragraphs with line breaks, **bold**, *italic*,
// ~~struck~~, `code`, [links](https://…), bare links, nested and numbered
// lists (with [ ] / [x] tasks), quotes, fenced code, tables and rules.
// Images become links: a reply should not make the browser fetch anything.

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "strong" | "em" | "del"; readonly children: Inline[] }
  | { readonly type: "link"; readonly href: string; readonly children: Inline[] }
  | { readonly type: "break" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  /** `true`/`false` for task items (`- [x]`), `null` otherwise. */
  readonly checked: boolean | null;
  readonly children: Block[];
}

export type Block =
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: Inline[] }
  | { readonly type: "paragraph"; readonly children: Inline[] }
  | { readonly type: "code"; readonly lang: string; readonly text: string }
  | { readonly type: "quote"; readonly children: Block[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: ListItem[];
    }
  | {
      readonly type: "table";
      readonly align: Align[];
      readonly head: Inline[][];
      readonly rows: Inline[][][];
    }
  | { readonly type: "rule" };

// ── Links ────────────────────────────────────────────────────────────────────

/** The address if it is safe to link to, else null. */
export function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return url.href;
    }
  } catch {
    // Not an absolute address.
  }
  return null;
}

// ── Inline ───────────────────────────────────────────────────────────────────

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;
const WORD = /[\p{L}\p{N}]/u;

/** Index of the `]` matching the `[` at `open`, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") i += 1;
    else if (c === "[") depth += 1;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

/** `(url "title")` starting at `open`: the url and the index after `)`. */
function linkTarget(text: string, open: number): { url: string; end: number } | null {
  if (text[open] !== "(") return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")" && --depth === 0) {
      const inner = text.slice(open + 1, i).trim();
      const url = inner.split(/\s+/)[0] ?? "";
      return { url, end: i + 1 };
    } else if (c === "\n") return null;
  }
  return null;
}

/** Where a `marker` run closes `text` from `from`, under emphasis rules, or -1. */
function closingDelimiter(text: string, from: number, marker: string): number {
  for (let i = from; i <= text.length - marker.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > 0) i = end;
      continue;
    }
    if (text.startsWith(marker, i) && i > from && !/\s/.test(text[i - 1] ?? "")) {
      // `_` closes only at a word edge, so snake_case stays as typed.
      if (marker[0] === "_" && WORD.test(text[i + marker.length] ?? "")) continue;
      // `*` followed by another `*` belongs to a longer run.
      if (marker === "*" && text[i + 1] === "*") {
        i += 1;
        continue;
      }
      return i;
    }
  }
  return -1;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };

  for (let i = 0; i < text.length;) {
    const c = text[i] as string;
    const prev = text[i - 1] ?? "";

    if (c === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push({ type: "break" });
      i += 1;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
      const end = text.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ type: "code", text: text.slice(i + run.length, end).trim() || " " });
        i = end + run.length;
        continue;
      }
    }
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const open = c === "!" ? i + 1 : i;
      const close = closingBracket(text, open);
      const target = close > 0 ? linkTarget(text, close + 1) : null;
      if (target) {
        const label = text.slice(open + 1, close);
        const href = safeHref(target.url);
        flush();
        const children = label ? parseInline(label) : [{ type: "text" as const, text: target.url }];
        // An unsafe address keeps its words and loses the link.
        if (href) out.push({ type: "link", href, children });
        else out.push(...children);
        i = target.end;
        continue;
      }
    }
    if (
      (c === "h" || c === "H") &&
      !WORD.test(prev) &&
      /^https?:\/\//i.test(text.slice(i, i + 8))
    ) {
      let url = /^https?:\/\/[^\s<>"]+/i.exec(text.slice(i))?.[0] ?? "";
      // Trailing punctuation is the sentence's, as is a ")" with no "(" in the address.
      url = url.replace(/[.,;:!?'*_]+$/, "");
      while (
        url.endsWith(")") &&
        (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)
      ) {
        url = url.slice(0, -1);
      }
      const href = safeHref(url);
      if (href) {
        flush();
        out.push({ type: "link", href, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }
    const strong = text.startsWith("**", i) ? "**" : text.startsWith("__", i) ? "__" : null;
    const marker =
      strong ??
      (text.startsWith("~~", i) ? "~~" : c === "*" || (c === "_" && !WORD.test(prev)) ? c : null);
    if (marker && !/\s/.test(text[i + marker.length] ?? " ")) {
      const end = closingDelimiter(text, i + marker.length, marker);
      if (end > 0) {
        flush();
        const children = parseInline(text.slice(i + marker.length, end));
        out.push({
          type: marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em",
          children,
        });
        i = end + marker.length;
        continue;
      }
    }
    buffer += c;
    i += 1;
  }
  flush();
  return out;
}

// ── Blocks ───────────────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^( *)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => /^ */.exec(line)?.[0].length ?? 0;
const blank = (line: string | undefined) => line === undefined || line.trim() === "";

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (row[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += row[i];
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? "";
  const next = lines[i + 1] ?? "";
  return line.includes("|") && next.includes("-") && TABLE_DIVIDER.test(next);
}

/** A line that starts a block other than a paragraph. */
function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    (LIST_ITEM.test(line) && indentOf(line) <= 3) ||
    isTableStart(lines, i)
  );
}

function parseList(lines: readonly string[], start: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? "") as RegExpExecArray;
  const base = (first[1] ?? "").length;
  const ordered = /\d/.test(first[2] ?? "");
  const items: { lines: string[] }[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = LIST_ITEM.exec(line);
    const isSibling =
      match && (match[1] ?? "").length === base && /\d/.test(match[2] ?? "") === ordered;
    if (isSibling) {
      const contentIndent = base + (match[2] ?? "").length + 1;
      const item = { lines: [match[3] ?? ""] };
      items.push(item);
      i += 1;
      // The item's own lines: indented ones, and unindented text right after
      // its first line (a lazy continuation), until a gap or a sibling.
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (blank(next)) {
          const after = lines.slice(i).find((l) => !blank(l));
          if (after === undefined || indentOf(after) <= base) break;
          item.lines.push("");
          i += 1;
          continue;
        }
        const indent = indentOf(next);
        if (indent > base) {
          item.lines.push(next.slice(Math.min(indent, contentIndent)));
          i += 1;
          continue;
        }
        if (!blank(lines[i - 1]) && !startsBlock(lines, i)) {
          item.lines.push(next.trim());
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (blank(line)) {
      const after = lines.slice(i).find((l) => !blank(l));
      const m = after ? LIST_ITEM.exec(after) : null;
      if (m && (m[1] ?? "").length === base && /\d/.test(m[2] ?? "") === ordered) {
        i += 1;
        continue;
      }
    }
    break;
  }

  return {
    block: {
      type: "list",
      ordered,
      start: ordered ? Number.parseInt(first[2] ?? "1", 10) || 1 : 1,
      items: items.map(({ lines: itemLines }) => {
        const task = /^\[([ xX])\]\s+/.exec(itemLines[0] ?? "");
        if (task) itemLines[0] = (itemLines[0] ?? "").slice(task[0].length);
        return {
          checked: task ? task[1] !== " " : null,
          children: parseBlocks(itemLines),
        };
      }),
    },
    next: i,
  };
}

function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (blank(line)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // The closing fence, if any.
      blocks.push({ type: "code", lang: (fence[2] ?? "").toLowerCase(), text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(QUOTE, ""));
        i += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(inner) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1] ?? "").map((cell): Align => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && (lines[i] ?? "").includes("|")) {
        const cells = splitRow(lines[i] ?? "");
        rows.push(head.map((_, n) => parseInline(cells[n] ?? "")));
        i += 1;
      }
      blocks.push({ type: "table", align, head: head.map((h) => parseInline(h)), rows });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) {
      paragraph.push((lines[i] ?? "").trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length)));
  return parseBlocks(lines);
}

// ── Helpers for the reply layout ─────────────────────────────────────────────

export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((n) =>
      n.type === "text" || n.type === "code"
        ? n.text
        : n.type === "break"
          ? " "
          : inlineText(n.children),
    )
    .join("");
}

/**
 * Section headings (levels 2 and 3), for a long answer's outline. `index`
 * counts every heading in document order, as the renderer does for ids.
 */
export function outline(
  blocks: readonly Block[],
): { level: number; text: string; index: number }[] {
  const found: { level: number; text: string; index: number }[] = [];
  let index = 0;
  const walk = (list: readonly Block[]) => {
    for (const b of list) {
      if (b.type === "heading") {
        if (b.level === 2 || b.level === 3) {
          found.push({ level: b.level, text: inlineText(b.children), index });
        }
        index += 1;
      } else if (b.type === "quote") walk(b.children);
      else if (b.type === "list") for (const item of b.items) walk(item.children);
    }
  };
  walk(blocks);
  return found;
}

/**
 * A reply reads as a document (full width, outline, collapsible) when it is
 * long or structured; short ones stay a chat bubble.
 */
export function isDocument(text: string, blocks: readonly Block[]): boolean {
  if (text.length > 1_400) return true;
  const headings = blocks.filter((b) => b.type === "heading").length;
  return headings >= 2 || blocks.some((b) => b.type === "table");
}

/** Every link in the reply, in order. */
export function linksIn(blocks: readonly Block[]): string[] {
  const found: string[] = [];
  const walkInline = (nodes: readonly Inline[]) => {
    for (const n of nodes) {
      if (n.type === "link") found.push(n.href);
      if ("children" in n) walkInline(n.children);
    }
  };
  const walk = (list: readonly Block[]) => {
    for (const b of list) {
      if (b.type === "heading" || b.type === "paragraph") walkInline(b.children);
      else if (b.type === "quote") walk(b.children);
      else if (b.type === "list") for (const item of b.items) walk(item.children);
      else if (b.type === "table") {
        for (const cell of b.head) walkInline(cell);
        for (const row of b.rows) for (const cell of row) walkInline(cell);
      }
    }
  };
  walk(blocks);
  return found;
}

/** Plain text of a Markdown preview, for one-line summaries (UX.11). */
export function previewText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/[*_`~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text of a reply's first heading, when it opens with one. */
export function leadingHeading(markdown: string): string | null {
  const match = /^\s*#{1,3}\s+(.+)$/m.exec(markdown);
  if (!match || markdown.trimStart().indexOf(match[0].trim()) !== 0) return null;
  return previewText(match[1] ?? "") || null;
}
