import {
  SandboxError,
  type AgentBrowser,
  type PageSnapshot,
  type SandboxHandle,
  type SandboxProvider,
} from "@ofa/core";

// A small website for browser evals (M3.11): pages with links, fields,
// checkboxes, radios and buttons, served to the agent through the same
// `AgentBrowser` port the sandbox's Chromium implements, as the same kind of
// outline (`[n] textbox "Email"`). No browser, no network: what the agent
// opened, typed and submitted is recorded for the checks.

export type SiteNode =
  | { readonly kind: "heading"; readonly text: string; readonly level?: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }
  | { readonly kind: "textbox"; readonly label: string; readonly field: string }
  | { readonly kind: "checkbox"; readonly label: string; readonly field: string }
  | {
      readonly kind: "radio";
      readonly label: string;
      readonly field: string;
      readonly value: string;
    }
  | { readonly kind: "submit"; readonly text: string };

export interface SitePage {
  readonly title: string;
  readonly nodes: readonly SiteNode[];
  /** Where the page's form goes when submitted, given what was filled in. */
  readonly submit?: (values: Readonly<Record<string, string | boolean>>) => string;
}

export interface FixtureSite {
  /** Pages by URL; a function sees what was submitted so far (e.g. a thank-you page). */
  readonly pages: Readonly<
    Record<string, SitePage | ((state: SiteRecord) => SitePage)>
  >;
}

/** What the agent did on the site. */
export interface SiteRecord {
  /** Every address it tried to open, found or not, in order. */
  readonly visited: string[];
  readonly submissions: { readonly url: string; readonly values: Record<string, string | boolean> }[];
}

function key(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** Element numbers: stable per page, and not 1, 2, 3 (like backend node IDs). */
const refOf = (i: number) => 200 + i * 7;

export function fixtureBrowser(site: FixtureSite): AgentBrowser & { readonly record: SiteRecord } {
  const pages = new Map(Object.entries(site.pages).map(([url, page]) => [key(url), { url, page }]));
  const record: SiteRecord = { visited: [], submissions: [] };
  const history: string[] = [];
  let index = -1;
  let values: Record<string, string | boolean> = {};

  const currentUrl = () => history[index] ?? "about:blank";
  const pageAt = (url: string): SitePage | null => {
    const found = pages.get(key(url));
    if (!found) return null;
    return typeof found.page === "function" ? found.page(record) : found.page;
  };
  const current = (): SitePage =>
    pageAt(currentUrl()) ?? { title: "", nodes: [{ kind: "text", text: "(blank page)" }] };

  function snapshot(): PageSnapshot {
    const page = current();
    const lines = page.nodes.map((node, i) => {
      const ref = `[${refOf(i)}] `;
      switch (node.kind) {
        case "heading":
          return `${"#".repeat(node.level ?? 2)} ${node.text}`;
        case "text":
          return node.text;
        case "link":
          return `${ref}link ${JSON.stringify(node.text)}`;
        case "textbox": {
          const value = values[node.field];
          return `${ref}textbox ${JSON.stringify(node.label)}${typeof value === "string" && value ? ` value=${JSON.stringify(value)}` : ""}`;
        }
        case "checkbox":
          return `${ref}checkbox ${JSON.stringify(node.label)}${values[node.field] === true ? " (checked)" : ""}`;
        case "radio":
          return `${ref}radio ${JSON.stringify(node.label)}${values[node.field] === node.value ? " (checked)" : ""}`;
        case "submit":
          return `${ref}button ${JSON.stringify(node.text)}`;
      }
    });
    return { url: currentUrl(), title: page.title, outline: lines.join("\n") };
  }

  function go(url: string): PageSnapshot {
    record.visited.push(url);
    if (!pageAt(url)) {
      throw new SandboxError("navigation_failed", `Couldn't open ${url} (net::ERR_NAME_NOT_RESOLVED).`);
    }
    history.splice(index + 1);
    history.push(url);
    index = history.length - 1;
    values = {};
    return snapshot();
  }

  function nodeAt(ref: number): SiteNode {
    const node = current().nodes.find((_, i) => refOf(i) === ref);
    if (!node || node.kind === "heading" || node.kind === "text") {
      throw new SandboxError(
        "no_element",
        `There is no visible element [${ref}] on this page any more. Take a fresh snapshot and use a number from it.`,
      );
    }
    return node;
  }

  function submit(): PageSnapshot {
    const page = current();
    if (!page.submit) return snapshot();
    record.submissions.push({ url: currentUrl(), values: { ...values } });
    return go(new URL(page.submit(values), currentUrl()).toString());
  }

  return {
    record,
    open: async (url) => go(url),
    snapshot: async () => snapshot(),
    click: async (ref) => {
      const node = nodeAt(ref);
      if (node.kind === "link") return go(new URL(node.href, currentUrl()).toString());
      if (node.kind === "checkbox") values[node.field] = values[node.field] !== true;
      if (node.kind === "radio") values[node.field] = node.value;
      if (node.kind === "submit") return submit();
      return snapshot();
    },
    type: async (ref, text, options = {}) => {
      const node = nodeAt(ref);
      if (node.kind !== "textbox") {
        throw new SandboxError("no_element", `Element [${ref}] can't take text.`);
      }
      const before = values[node.field];
      values[node.field] = options.clear || typeof before !== "string" ? text : before + text;
      return options.submit ? submit() : snapshot();
    },
    press: async (key) => (key === "Enter" ? submit() : snapshot()),
    back: async () => {
      if (index <= 0) throw new SandboxError("bad_request", "There is no earlier page to go back to.");
      index -= 1;
      values = {};
      return snapshot();
    },
    describe: async (ref) => {
      const page = current();
      const node = ref === undefined ? undefined : page.nodes.find((_, i) => refOf(i) === ref);
      const element =
        node && node.kind !== "heading" && node.kind !== "text"
          ? {
              role: node.kind === "submit" ? "button" : node.kind,
              name: node.kind === "link" || node.kind === "submit" ? node.text : node.label,
            }
          : undefined;
      return { url: currentUrl(), title: page.title, ...(element ? { element } : {}) };
    },
  };
}

/** A computer with only this browser: the shell and files are not part of browser evals. */
export function fixtureComputer(browser: AgentBrowser): SandboxProvider {
  const none = async (): Promise<never> => {
    throw new SandboxError("unavailable", "Only the browser is available in this eval.");
  };
  const handle: SandboxHandle = {
    id: "fixture",
    exec: none,
    readFile: none,
    writeFile: none,
    listFiles: none,
    browser: async () => browser,
    shareLogin: none,
    screen: none,
    takeover: none,
    restart: none,
    health: async () => ({ ok: true }),
  };
  return { acquire: async () => handle, pause: async () => {}, release: async () => {} };
}
