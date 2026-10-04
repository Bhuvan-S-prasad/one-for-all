import { describe, expect, it } from "vitest";
import { outlineFromAXTree, titleFromAXTree, type AXNode } from "./snapshot";

let next = 0;
function node(
  role: string,
  options: Partial<Omit<AXNode, "role" | "nodeId">> & { children?: AXNode[]; text?: string } = {},
): AXNode {
  const { children = [], text, ...rest } = options;
  const id = String(next++);
  return {
    nodeId: id,
    role: { value: role },
    ...(text !== undefined ? { name: { value: text } } : {}),
    childIds: children.map((c) => c.nodeId),
    ...rest,
    // Children are flattened by `tree` below.
    ...({ _children: children } as object),
  };
}

/** Flatten a nested tree into the list CDP returns, with parent links. */
function tree(root: AXNode): AXNode[] {
  const out: AXNode[] = [];
  const visit = (n: AXNode, parentId?: string) => {
    out.push({ ...n, ...(parentId ? { parentId } : {}) });
    for (const child of (n as unknown as { _children: AXNode[] })._children) visit(child, n.nodeId);
  };
  visit(root);
  return out;
}

describe("outlineFromAXTree", () => {
  it("writes a sign-in page as headings, text and numbered controls", () => {
    const nodes = tree(
      node("RootWebArea", {
        text: "Sign in · Example",
        children: [
          node("heading", {
            text: "Sign in",
            properties: [{ name: "level", value: { value: 1 } }],
            children: [node("StaticText", { text: "Sign in" })],
          }),
          node("paragraph", {
            children: [
              node("StaticText", { text: "Welcome back." }),
              node("StaticText", { text: "Use your work account." }),
            ],
          }),
          node("textbox", {
            text: "Email",
            backendDOMNodeId: 412,
            value: { value: "sam@example.com" },
            properties: [{ name: "required", value: { value: true } }],
          }),
          node("checkbox", {
            text: "Remember me",
            backendDOMNodeId: 418,
            properties: [{ name: "checked", value: { value: "true" } }],
          }),
          node("generic", {
            ignored: true,
            children: [
              node("button", {
                text: "Sign in",
                backendDOMNodeId: 421,
                children: [node("StaticText", { text: "Sign in" })],
              }),
            ],
          }),
          node("image", { text: "" }),
          node("list", {
            children: [
              node("listitem", { children: [node("StaticText", { text: "Fast" })] }),
              node("listitem", { children: [node("StaticText", { text: "Private" })] }),
            ],
          }),
        ],
      }),
    );
    expect(outlineFromAXTree(nodes)).toBe(
      [
        "# Sign in",
        "Welcome back. Use your work account.",
        '[412] textbox "Email" value="sam@example.com" (required)',
        '[418] checkbox "Remember me" (checked)',
        '[421] button "Sign in"',
        "- Fast",
        "- Private",
      ].join("\n"),
    );
    expect(titleFromAXTree(nodes)).toBe("Sign in · Example");
  });

  it("lists a select's options and clips very long text", () => {
    const nodes = tree(
      node("RootWebArea", {
        children: [
          node("combobox", {
            text: "Country",
            backendDOMNodeId: 7,
            children: [
              node("option", {
                text: "India",
                backendDOMNodeId: 8,
                properties: [{ name: "selected", value: { value: true } }],
              }),
              node("option", { text: "Japan", backendDOMNodeId: 9 }),
            ],
          }),
          node("paragraph", { children: [node("StaticText", { text: "x".repeat(400) })] }),
        ],
      }),
    );
    const lines = outlineFromAXTree(nodes).split("\n");
    expect(lines.slice(0, 3)).toEqual([
      '[7] combobox "Country"',
      '[8] option "India" (selected)',
      '[9] option "Japan"',
    ]);
    expect(lines[3]).toHaveLength(300);
    expect(lines[3]?.endsWith("…")).toBe(true);
  });
});
