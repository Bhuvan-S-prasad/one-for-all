import { describe, expect, it } from "vitest";
import {
  inlineText,
  isDocument,
  leadingHeading,
  linksIn,
  outline,
  parseInline,
  parseMarkdown,
  previewText,
  safeHref,
  type Block,
} from "./markdown";

const text = (s: string) => ({ type: "text", text: s });

describe("inline", () => {
  it("reads bold, italic, struck and code", () => {
    expect(parseInline("a **b** *c* ~~d~~ `e`")).toEqual([
      text("a "),
      { type: "strong", children: [text("b")] },
      text(" "),
      { type: "em", children: [text("c")] },
      text(" "),
      { type: "del", children: [text("d")] },
      text(" "),
      { type: "code", text: "e" },
    ]);
  });

  it("leaves snake_case, lone stars and maths alone", () => {
    expect(inlineText(parseInline("use run_id and 2 * 3 * 4"))).toBe("use run_id and 2 * 3 * 4");
    expect(parseInline("my_var_name")).toEqual([text("my_var_name")]);
  });

  it("turns [text](url) into a link, and drops unsafe addresses", () => {
    expect(parseInline("see [LinkedIn](https://linkedin.com/x)")).toEqual([
      text("see "),
      { type: "link", href: "https://linkedin.com/x", children: [text("LinkedIn")] },
    ]);
    expect(parseInline("[click](javascript:alert(1))")).toEqual([text("click")]);
    expect(parseInline("![pic](https://evil.example/t.png)")).toEqual([
      { type: "link", href: "https://evil.example/t.png", children: [text("pic")] },
    ]);
  });

  it("links bare addresses without the sentence's punctuation", () => {
    expect(parseInline("Read https://a.example/x.")).toEqual([
      text("Read "),
      { type: "link", href: "https://a.example/x", children: [text("https://a.example/x")] },
      text("."),
    ]);
    expect(linksIn(parseMarkdown("(see https://a.example/wiki/A_(b))"))).toEqual([
      "https://a.example/wiki/A_(b)",
    ]);
  });

  it("never treats markup as markup", () => {
    expect(parseInline("<script>alert(1)</script>")).toEqual([text("<script>alert(1)</script>")]);
  });
});

describe("blocks", () => {
  it("reads headings, paragraphs with line breaks and rules", () => {
    expect(parseMarkdown("## Title\n\nOne\ntwo\n\n---")).toEqual([
      { type: "heading", level: 2, children: [text("Title")] },
      { type: "paragraph", children: [text("One"), { type: "break" }, text("two")] },
      { type: "rule" },
    ]);
  });

  it("nests lists by indentation, numbered or not", () => {
    const [list] = parseMarkdown(
      "1. **Context**: what it sees\n   - the task\n   - the plan\n2. Tools\n\n3. Checks",
    ) as [Extract<Block, { type: "list" }>];
    expect(list).toMatchObject({ type: "list", ordered: true, start: 1 });
    expect(list.items).toHaveLength(3);
    const nested = list.items[0]?.children[1];
    expect(nested).toMatchObject({ type: "list", ordered: false });
    expect((nested as Extract<Block, { type: "list" }>).items).toHaveLength(2);
  });

  it("reads the dash-dash lists from the screenshot as nested items", () => {
    const [list] = parseMarkdown("- Pillars\n  - Context\n  - Tools\n- Sources") as [
      Extract<Block, { type: "list" }>,
    ];
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.children[1]).toMatchObject({ type: "list" });
  });

  it("reads task items", () => {
    const [list] = parseMarkdown("- [x] done\n- [ ] todo") as [Extract<Block, { type: "list" }>];
    expect(list.items.map((i) => i.checked)).toEqual([true, false]);
  });

  it("reads tables with alignment and escaped pipes", () => {
    const [table] = parseMarkdown(
      "| Pillar | Tokens |\n|:--|--:|\n| Context | 1\\|2 |\n| Tools | 3 |",
    );
    expect(table).toMatchObject({ type: "table", align: ["left", "right"] });
    expect((table as Extract<Block, { type: "table" }>).rows).toHaveLength(2);
    expect(inlineText((table as Extract<Block, { type: "table" }>).rows[0]![1]!)).toBe("1|2");
  });

  it("keeps fenced code as typed", () => {
    expect(parseMarkdown("```ts\nconst a = **b**;\n```")).toEqual([
      { type: "code", lang: "ts", text: "const a = **b**;" },
    ]);
  });

  it("reads quotes, including blocks inside them", () => {
    expect(parseMarkdown("> **Note**\n> - one")).toMatchObject([
      { type: "quote", children: [{ type: "paragraph" }, { type: "list" }] },
    ]);
  });
});

describe("layout helpers", () => {
  it("knows a long or structured answer from a short one", () => {
    const short = "Paris.";
    expect(isDocument(short, parseMarkdown(short))).toBe(false);
    const report = "## A\ntext\n## B\ntext";
    expect(isDocument(report, parseMarkdown(report))).toBe(true);
    expect(outline(parseMarkdown(report))).toEqual([
      { level: 2, text: "A", index: 0 },
      { level: 2, text: "B", index: 1 },
    ]);
  });

  it("only lets safe addresses through", () => {
    expect(safeHref("https://a.example")).toBe("https://a.example/");
    expect(safeHref("mailto:x@y.example")).toBe("mailto:x@y.example");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
  });
});

describe("previewText and leadingHeading", () => {
  it("strips Markdown down to readable text", () => {
    expect(
      previewText(
        "## Five pillars\n\n- **Context**: what the model sees ([notes](https://a.example))\n- `Tools`\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      ),
    ).toBe("Five pillars Context : what the model sees (notes) Tools a b 1 2");
  });

  it("finds a heading only when the reply opens with it", () => {
    expect(leadingHeading("# Harness engineering\n\nBody")).toBe("Harness engineering");
    expect(leadingHeading("Intro first.\n\n## Later")).toBeNull();
  });
});
