// A small TypeScript highlighter for reading code: comments, strings,
// keywords, numbers and type names. It tokenizes line by line, carrying open
// block comments and template strings across lines. Output is plain tokens;
// React renders them as text, never as HTML.

export type TokenKind = "comment" | "string" | "keyword" | "number" | "type" | "plain";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const KEYWORDS = new Set(
  "abstract as async await break case catch class const continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while with yield".split(
    " ",
  ),
);

type Mode = "code" | "block" | "template";

/** Tokens for every line, in order. */
export function highlight(source: string): Token[][] {
  const lines = source.split("\n");
  const out: Token[][] = [];
  let mode: Mode = "code";
  for (const line of lines) {
    const tokens: Token[] = [];
    let i = 0;
    let lastWasWord = false;
    const push = (kind: TokenKind, text: string, word = false) => {
      if (!text) return;
      const last = tokens.at(-1);
      // Runs of punctuation and comments merge; a name stays alone, to be linked.
      if (last && last.kind === kind && !word && !lastWasWord) {
        tokens[tokens.length - 1] = { kind, text: last.text + text };
      } else tokens.push({ kind, text });
      lastWasWord = word;
    };
    while (i < line.length) {
      if (mode === "block") {
        const end = line.indexOf("*/", i);
        if (end < 0) {
          push("comment", line.slice(i));
          i = line.length;
        } else {
          push("comment", line.slice(i, end + 2));
          i = end + 2;
          mode = "code";
        }
        continue;
      }
      if (mode === "template") {
        let j = i;
        while (j < line.length && line[j] !== "`") j += line[j] === "\\" ? 2 : 1;
        if (j >= line.length) {
          push("string", line.slice(i));
          i = line.length;
        } else {
          push("string", line.slice(i, j + 1));
          i = j + 1;
          mode = "code";
        }
        continue;
      }
      const rest = line.slice(i);
      if (rest.startsWith("//")) {
        push("comment", rest);
        break;
      }
      if (rest.startsWith("/*")) {
        mode = "block";
        continue;
      }
      const c = line[i]!;
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
        push("string", line.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (c === "`") {
        push("string", "`");
        i += 1;
        mode = "template";
        continue;
      }
      const word = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (word) {
        const w = word[0];
        const kind: TokenKind = KEYWORDS.has(w) ? "keyword" : /^[A-Z]/.test(w) ? "type" : "plain";
        push(kind, w, true);
        i += w.length;
        continue;
      }
      const num = /^\d[\d_]*(\.\d+)?/.exec(rest);
      if (num) {
        push("number", num[0]);
        i += num[0].length;
        continue;
      }
      push("plain", c);
      i += 1;
    }
    out.push(tokens);
  }
  return out;
}
