import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";
import { collectRefs, narrow, parseBlockRef, parsePage, splitApiRef, splitCodeRef } from "./refs";

// How written pages point at the code (ADR-0051), and the highlighter that
// lets call names become links.

describe("parsePage", () => {
  it("reads the front matter and the order from the file name", () => {
    const page = parsePage(
      "path",
      "02-the-repo.md",
      "---\ntitle: The repo\nsummary: Packages and tools.\n---\n\n## Hello\n",
    );
    expect(page).toMatchObject({
      section: "path",
      slug: "the-repo",
      order: 2,
      title: "The repo",
      summary: "Packages and tools.",
    });
    expect(page.body.trim()).toBe("## Hello");
  });
});

describe("references", () => {
  it("splits symbol, file and endpoint references", () => {
    expect(splitCodeRef("packages/harness/src/loop.ts#runAgent")).toEqual({
      path: "packages/harness/src/loop.ts",
      symbol: "runAgent",
    });
    expect(splitCodeRef("packages/harness/src/loop.ts")).toEqual({
      path: "packages/harness/src/loop.ts",
      symbol: null,
    });
    expect(splitApiRef("post:/api/threads/:id/messages")).toEqual({
      method: "POST",
      path: "/api/threads/:id/messages",
    });
  });

  it("reads a block's reference and its from, to and title lines", () => {
    expect(
      parseBlockRef("packages/a.ts#f\nfrom: const x = 1;\nto: return x;\ntitle: The bit"),
    ).toEqual({ ref: "packages/a.ts#f", from: "const x = 1;", to: "return x;", title: "The bit" });
  });

  it("collects reference blocks and links, but not other code blocks", () => {
    const md = [
      "See [the loop](code:packages/harness/src/loop.ts#runAgent) and [thread](table:thread).",
      "```code",
      "packages/a.ts#f",
      "from: start",
      "```",
      "```ts",
      "const notARef = '[x](table:nope)';",
      "```",
      "```endpoints",
      "/api/threads",
      "```",
    ].join("\n");
    expect(collectRefs(md).map((r) => [r.kind, r.ref, r.from])).toEqual([
      ["code", "packages/a.ts#f", "start"],
      ["endpoints", "/api/threads", null],
      ["code", "packages/harness/src/loop.ts#runAgent", null],
      ["table", "thread", null],
    ]);
  });
});

describe("narrow", () => {
  const text = ["function f() {", "  const a = 1;", "  const b = 2;", "  return a + b;", "}"].join(
    "\n",
  );

  it("keeps the lines between the two anchors, both included", () => {
    expect(narrow(text, 1, 5, "const a", "return")).toEqual({ start: 2, end: 4 });
    expect(narrow(text, 1, 5, "const b", null)).toEqual({ start: 3, end: 5 });
  });

  it("searches only inside the symbol, and says when an anchor is gone", () => {
    expect(narrow(text, 3, 5, "const a", null)).toBeNull();
    expect(narrow(text, 1, 5, "const a", "missing")).toBeNull();
  });
});

describe("highlight", () => {
  it("keeps each name its own token, so a call can be a link", () => {
    const [line] = highlight("const turn = await startTurn(deps.db, tenant);");
    expect(
      line!.filter((t) => t.kind === "plain" && /^\w+$/.test(t.text)).map((t) => t.text),
    ).toEqual(["turn", "startTurn", "deps", "db", "tenant"]);
    expect(line!.find((t) => t.text === "await")?.kind).toBe("keyword");
  });

  it("carries block comments and template strings across lines", () => {
    const lines = highlight("/* one\ntwo */ x\nconst s = `a\nb` + y;");
    expect(lines[0]).toEqual([{ kind: "comment", text: "/* one" }]);
    expect(lines[1]![0]).toEqual({ kind: "comment", text: "two */" });
    expect(lines[3]![0]).toEqual({ kind: "string", text: "b`" });
  });
});
