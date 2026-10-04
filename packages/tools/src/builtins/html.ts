// HTML to readable text, without a DOM: enough for an agent to read an
// article. The browser in the sandbox (M3) handles everything harder.

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X"))
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function htmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() || null : null;
}

export function htmlToText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return decodeEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|template|iframe|nav|footer|form)\b[\s\S]*?<\/\1>/gi,
        " ",
      )
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|section|article|header|h[1-6]|tr|table|blockquote|pre)>/gi, "\n")
      .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n${"#".repeat(Number(level))} `)
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
