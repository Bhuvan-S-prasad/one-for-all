// A page as text, from Chromium's accessibility tree (M3.04): what a person
// would see, in reading order, with every element the agent can act on
// numbered. The number is the element's backend DOM node ID, which stays
// valid for the page's lifetime from any connection, so nothing has to be
// remembered between tool calls.
//
//   # Sign in
//   Welcome back. Use your work account.
//   [412] textbox "Email"
//   [415] textbox "Password"
//   [418] checkbox "Remember me" (checked)
//   [421] button "Sign in"
//   [424] link "Forgot your password?"

/** The parts of `Accessibility.getFullAXTree` nodes this reads. */
export interface AXValue {
  readonly type?: string;
  readonly value?: unknown;
}

export interface AXNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AXValue;
  readonly name?: AXValue;
  readonly value?: AXValue;
  readonly properties?: readonly { readonly name: string; readonly value: AXValue }[];
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
  readonly parentId?: string;
}

/** Roles an agent can act on, shown with their number. */
const ACTIONABLE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
  "listbox",
  "treeitem",
]);

/** Roles whose children are their own label: shown on one line, not walked. */
const LEAF = new Set([...ACTIONABLE, "heading", "image", "img"]);
LEAF.delete("listbox");
LEAF.delete("combobox");

/** Containers that start a new line of text. */
const BLOCK = new Set([
  "paragraph",
  "listitem",
  "row",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "article",
  "section",
  "main",
  "navigation",
  "list",
  "table",
  "form",
  "dialog",
  "alertdialog",
  "alert",
  "banner",
  "contentinfo",
  "complementary",
  "region",
  "group",
  "LineBreak",
  "blockquote",
  "figure",
  "Pre",
  "code",
]);

const MAX_LINE = 300;

const str = (value: AXValue | undefined): string =>
  typeof value?.value === "string" ? value.value.replace(/\s+/g, " ").trim() : "";

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

function clip(text: string, max = MAX_LINE): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describe(node: AXNode, role: string): string {
  const name = clip(str(node.name), 160);
  const parts: string[] = [role === "img" ? "image" : role];
  if (name) parts.push(JSON.stringify(name));
  const value = str(node.value);
  if (
    value &&
    value !== name &&
    ["textbox", "searchbox", "combobox", "spinbutton", "slider"].includes(role)
  ) {
    parts.push(`value=${JSON.stringify(clip(value, 120))}`);
  }
  const states: string[] = [];
  const checked = prop(node, "checked");
  if (checked === "true" || checked === true) states.push("checked");
  if (checked === "mixed") states.push("partly checked");
  if (prop(node, "selected") === true) states.push("selected");
  if (prop(node, "expanded") === true) states.push("expanded");
  if (prop(node, "expanded") === false) states.push("collapsed");
  if (prop(node, "disabled") === true) states.push("disabled");
  if (prop(node, "required") === true) states.push("required");
  if (prop(node, "focused") === true) states.push("focused");
  if (states.length) parts.push(`(${states.join(", ")})`);
  return parts.join(" ");
}

/** The outline of a page; `[n]` numbers are backend DOM node IDs for `click` and `type`. */
export function outlineFromAXTree(nodes: readonly AXNode[]): string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const lines: string[] = [];
  let pending = "";

  const flush = () => {
    const text = pending.replace(/\s+/g, " ").trim();
    if (text) lines.push(clip(text));
    pending = "";
  };

  const walk = (node: AXNode | undefined, depth: number) => {
    if (!node || depth > 200) return;
    const role = str(node.role);
    const children = () => {
      for (const id of node.childIds ?? []) walk(byId.get(id), depth + 1);
    };
    if (node.ignored) return children();

    if (role === "StaticText" || role === "text") {
      const text = str(node.name);
      if (text) pending += ` ${text}`;
      return;
    }
    if (role === "heading") {
      flush();
      const level = Number(prop(node, "level")) || 2;
      const text = str(node.name);
      if (text) lines.push(clip(`${"#".repeat(Math.min(level, 6))} ${text}`));
      return;
    }
    if (LEAF.has(role) || ACTIONABLE.has(role)) {
      const name = str(node.name);
      // Unnamed images say nothing; unnamed controls still can be used.
      if ((role === "image" || role === "img") && !name) return;
      flush();
      // A label's text just before its control says the same thing twice.
      if (name && lines.at(-1) === name) lines.pop();
      const ref =
        ACTIONABLE.has(role) && node.backendDOMNodeId ? `[${node.backendDOMNodeId}] ` : "";
      lines.push(clip(`${ref}${describe(node, role)}`));
      if (!LEAF.has(role)) children(); // listbox, combobox: list their options
      return;
    }
    const block = BLOCK.has(role);
    if (block) flush();
    if (role === "listitem") pending += "- ";
    children();
    if (block) flush();
  };

  walk(root, 0);
  flush();
  // Collapse runs of identical lines (repeated nav, decorative text).
  return lines.filter((line, i) => line !== lines[i - 1]).join("\n");
}

/** The page's title, from the root of its tree. */
export function titleFromAXTree(nodes: readonly AXNode[]): string {
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  return root ? str(root.name) : "";
}
