import {
  hostMatchesSite,
  normalizeLoginSite,
  type AgentBrowser,
  type PageSnapshot,
  type SandboxHandle,
  type SandboxProvider,
} from "@ofa/core";
import { z } from "zod";
import { defineTool, type ToolRunContext } from "../define";
import { READ_CHUNK_CHARS } from "./web";

// The computer tools (M3.05, ARCHITECTURE.md §9.3): a browser driven through
// the page's accessibility tree, a shell and files, all in the agent's
// sandbox as the agent's own user (ADR-0010, ADR-0025). Everything they bring
// back can come from outside, so results are untrusted (§10.3).
//
// Risk, which policy reads (hard rule 5): opening and reading pages is like
// web.read_url. Clicking, typing and pressing keys act on a site for the
// person, and a shell can send data anywhere the egress allowlist reaches, so
// those are outbound: after a run reads untrusted content they need a
// person's approval.

const KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
] as const;

const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  py: "text/x-python",
  js: "text/javascript",
  sh: "text/x-shellscript",
  svg: "image/svg+xml",
};

/** A file's type from its name; plain text when unknown (everything written here is text). */
export function mimeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "text/plain";
}

/** Output kept from a command, per stream. */
const SHELL_OUTPUT_CHARS = 8_000;

function notConfigured(): never {
  throw Object.assign(new Error("This server has no computer for agents yet (SANDBOX_URL)."), {
    code: "not_configured",
  });
}

async function computer(
  sandbox: SandboxProvider | null,
  ctx: ToolRunContext,
): Promise<SandboxHandle> {
  if (!sandbox) notConfigured();
  return sandbox.acquire(ctx);
}

async function browserOf(
  sandbox: SandboxProvider | null,
  ctx: ToolRunContext,
): Promise<AgentBrowser> {
  return (await computer(sandbox, ctx)).browser(ctx.agentId);
}

/** A page for the model, a chunk at a time, like web.read_url. */
export function pageText(page: PageSnapshot, from = 0): string {
  const chunk = page.outline.slice(from, from + READ_CHUNK_CHARS);
  const end = from + chunk.length;
  const more =
    end < page.outline.length
      ? `\n…[characters ${from}–${end} of ${page.outline.length}; call browser.snapshot with from: ${end} to read more]`
      : "";
  return `Page: ${page.title || "(untitled)"}\nURL: ${page.url}\n\n${chunk || "(nothing more on this page)"}${more}`;
}

// ── Approval cards: what a call would do, in a person's words ────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "a blank page";
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `the button “Pay now” on shop.example`, from the agent's browser as it is now. */
async function target(
  sandbox: SandboxProvider | null,
  ctx: ToolRunContext,
  element?: number,
): Promise<string> {
  const page = await (await browserOf(sandbox, ctx)).describe(element);
  const site = hostOf(page.url);
  if (element === undefined) return site;
  const what = page.element
    ? `the ${page.element.role || "element"}${page.element.name ? ` “${clip(page.element.name, 80)}”` : ""}`
    : `element [${element}]`;
  return `${what} on ${site}`;
}

/** The site of the page in the agent's browser now, for "allow on this site for this task" (M4.07). */
async function currentSite(
  sandbox: SandboxProvider | null,
  ctx: ToolRunContext,
): Promise<string | null> {
  return normalizeLoginSite((await (await browserOf(sandbox, ctx)).describe()).url);
}

const ref = z
  .number()
  .int()
  .positive()
  .describe("The element's number from the latest snapshot, e.g. 412 for [412]");

export function browserTools(sandbox: SandboxProvider | null) {
  const page = (snapshot: PageSnapshot) => ({ content: pageText(snapshot), untrusted: true });
  return [
    defineTool({
      name: "browser.open",
      description:
        "Open a web page in your own browser and see it as an outline: headings, text, and every link, button and field with a number in brackets. Use those numbers with browser.click and browser.type. Logins you have made in your browser stay.",
      input: z.object({ url: z.url().max(2_000).describe("The page to open") }),
      annotations: { readOnly: true, opensUrl: "url" },
      async run({ url }, ctx) {
        return page(await (await browserOf(sandbox, ctx)).open(url));
      },
      async describe({ url }) {
        return `Open ${url}`;
      },
      async site({ url }) {
        return normalizeLoginSite(url);
      },
    }),
    defineTool({
      name: "browser.snapshot",
      description: `See the current page in your browser again, ${READ_CHUNK_CHARS.toLocaleString("en")} characters at a time.`,
      input: z.object({
        from: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Character to start from, to read further"),
      }),
      annotations: { readOnly: true, idempotent: true },
      async run({ from }, ctx) {
        const snapshot = await (await browserOf(sandbox, ctx)).snapshot();
        return { content: pageText(snapshot, from), untrusted: true };
      },
    }),
    defineTool({
      name: "browser.click",
      description:
        "Click a link, button, checkbox or other element by its number. Returns the page afterwards.",
      input: z.object({ ref }),
      annotations: { outbound: true },
      async run(args, ctx) {
        return page(await (await browserOf(sandbox, ctx)).click(args.ref));
      },
      async describe(args, ctx) {
        return `Click ${await target(sandbox, ctx, args.ref)}`;
      },
      site: (_args, ctx) => currentSite(sandbox, ctx),
    }),
    defineTool({
      name: "browser.type",
      description:
        "Type text into a field by its number. Set clear to replace what is there, and submit to press Enter afterwards. Never type passwords: ask the person to sign in themselves.",
      input: z.object({
        ref,
        text: z.string().max(5_000),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
      }),
      annotations: { outbound: true },
      async run({ ref: element, text, clear, submit }, ctx) {
        return page(await (await browserOf(sandbox, ctx)).type(element, text, { clear, submit }));
      },
      async describe({ ref: element, text, submit }, ctx) {
        return `Type “${clip(text, 300)}” into ${await target(sandbox, ctx, element)}${submit ? ", then press Enter" : ""}`;
      },
      site: (_args, ctx) => currentSite(sandbox, ctx),
    }),
    defineTool({
      name: "browser.press",
      description: "Press a key in the browser, e.g. Enter, Tab, Escape or PageDown.",
      input: z.object({ key: z.enum(KEYS) }),
      annotations: { outbound: true },
      async run({ key }, ctx) {
        return page(await (await browserOf(sandbox, ctx)).press(key));
      },
      async describe({ key }, ctx) {
        return `Press ${key} on ${await target(sandbox, ctx)}`;
      },
      site: (_args, ctx) => currentSite(sandbox, ctx),
    }),
    defineTool({
      name: "browser.back",
      description: "Go back to the previous page.",
      input: z.object({}),
      annotations: { readOnly: true },
      async run(_args, ctx) {
        return page(await (await browserOf(sandbox, ctx)).back());
      },
    }),
  ];
}

/**
 * Sign in with a saved login (M3.08, ADR-0012): the tool types the username
 * and password into the page's fields; the agent picks the fields and never
 * sees the values. Only into a page on the login's own site, so a page that
 * talks the agent into it cannot collect another site's password.
 */
export function useSavedLoginTool(sandbox: SandboxProvider | null) {
  return defineTool({
    name: "use_saved_login",
    description:
      "Sign in on the current page with a login the person saved for this site. Give the numbers of the username and password fields from the latest snapshot; the tool types them in, and you never see the password. Works only on the saved site's own pages.",
    input: z.object({
      username_ref: ref
        .optional()
        .describe("The username or email field; leave out if the page asks only for the password"),
      password_ref: ref.describe("The password field"),
      submit: z.boolean().default(true).describe("Press Enter after the password"),
    }),
    annotations: { outbound: true },
    async describe(_args, ctx) {
      return `Sign in on ${await target(sandbox, ctx)} with the login saved for it`;
    },
    async run({ username_ref, password_ref, submit }, ctx) {
      const browser = await browserOf(sandbox, ctx);
      const page = await browser.snapshot();
      let host = "";
      try {
        host = new URL(page.url).hostname;
      } catch {
        // about:blank and the like: no site.
      }
      // A login saved for github.com serves login.github.com too: try the
      // page's host, then each parent down to two labels.
      const pageSite = normalizeLoginSite(host);
      const labels = pageSite?.split(".") ?? [];
      let site: string | null = null;
      let login: { username: string; password: string } | null = null;
      for (let i = 0; i <= labels.length - 2 && ctx.logins && !login; i += 1) {
        const candidate = labels.slice(i).join(".");
        login = await ctx.logins.get(candidate);
        if (login) site = candidate;
      }
      if (!site || !login || !hostMatchesSite(host, site)) {
        throw Object.assign(
          new Error(
            `There is no saved login for ${host || "this page"}. Ask the person to sign in themselves (they can take over your browser), or to save a login for this site in Settings.`,
          ),
          { code: "no_saved_login" },
        );
      }
      if (username_ref !== undefined)
        await browser.type(username_ref, login.username, { clear: true });
      const after = await browser.type(password_ref, login.password, { clear: true, submit });
      // Never hand the values back, even if a page echoes them.
      const scrub = (text: string) =>
        text.split(login.password).join("[REDACTED]").split(login.username).join("[username]");
      return {
        content: `Typed the saved login for ${site}.\n\n${scrub(pageText(after))}`,
        untrusted: true,
      };
    },
  });
}

function clipOutput(text: string, limit: number, keep: "head" | "tail"): string {
  if (text.length <= limit) return text;
  return keep === "tail"
    ? `…[${text.length - limit} earlier characters cut]\n${text.slice(-limit)}`
    : `${text.slice(0, limit)}\n…[${text.length - limit} more characters cut]`;
}

export function shellTool(sandbox: SandboxProvider | null) {
  return defineTool({
    name: "shell.run",
    description:
      "Run a bash command on your computer (Debian, with Python 3, git, curl and jq), in the shared /workspace folder unless you give cwd. Files there are shared with your other agents; ~ is yours alone. Python runs in your own venv: `pip install` works, and openpyxl (Excel) and python-docx (Word) are already there. Returns the exit code and output.",
    input: z.object({
      command: z.string().trim().min(1).max(20_000),
      cwd: z.string().max(4_096).optional().describe("Folder to run in; /workspace by default"),
      timeout_seconds: z.number().int().min(1).max(600).default(60),
    }),
    annotations: { outbound: true },
    async describe({ command, cwd }) {
      const shown = command.length > 600 ? `${command.slice(0, 599)}…` : command;
      return `Run a command on its computer${cwd ? ` in ${cwd}` : ""}:\n${shown}`;
    },
    async run({ command, cwd, timeout_seconds }, ctx) {
      const handle = await computer(sandbox, ctx);
      const result = await handle.exec(ctx.agentId, command, {
        cwd,
        timeoutMs: timeout_seconds * 1000,
      });
      const lines = [
        result.timedOut
          ? `Stopped after ${timeout_seconds} s (time limit).`
          : `Exit code ${result.exitCode}.`,
      ];
      // The end of a command's output usually says what happened.
      if (result.stdout)
        lines.push(`stdout:\n${clipOutput(result.stdout, SHELL_OUTPUT_CHARS, "tail")}`);
      if (result.stderr)
        lines.push(`stderr:\n${clipOutput(result.stderr, SHELL_OUTPUT_CHARS / 4, "tail")}`);
      if (!result.stdout && !result.stderr) lines.push("(no output)");
      return { content: lines.join("\n\n"), untrusted: true };
    },
  });
}

export function fileTools(sandbox: SandboxProvider | null) {
  return [
    defineTool({
      name: "files.read",
      description: `Read a text file on your computer, ${READ_CHUNK_CHARS.toLocaleString("en")} characters at a time. Paths are relative to /workspace unless they start with / (your own folder is ~ in shell.run).`,
      input: z.object({
        path: z.string().min(1).max(4_096),
        from: z.number().int().min(0).default(0),
      }),
      annotations: { readOnly: true, idempotent: true },
      async run({ path, from }, ctx) {
        const bytes = await (await computer(sandbox, ctx)).readFile(ctx.agentId, path);
        if (bytes.includes(0)) {
          return {
            content: `${path} is a binary file (${bytes.length.toLocaleString("en")} bytes); it can't be shown as text.`,
            untrusted: true,
          };
        }
        const text = new TextDecoder().decode(bytes);
        const chunk = text.slice(from, from + READ_CHUNK_CHARS);
        const end = from + chunk.length;
        const more =
          end < text.length
            ? `\n…[characters ${from}–${end} of ${text.length}; call again with from: ${end} to read more]`
            : "";
        return { content: `${chunk || "(nothing more in this file)"}${more}`, untrusted: true };
      },
    }),
    defineTool({
      name: "files.write",
      description:
        "Write a text file on your computer, replacing it if it exists; folders are created as needed. Paths are relative to /workspace, which your other agents can read too.",
      input: z.object({
        path: z.string().min(1).max(4_096),
        content: z.string().max(500_000),
      }),
      annotations: { idempotent: true },
      async run({ path, content }, ctx) {
        await (await computer(sandbox, ctx)).writeFile(ctx.agentId, path, content);
        // A copy for the person, shown as a file card with the reply (M3.06).
        const kept = await ctx.artifacts?.put({
          key: `${ctx.idempotencyKey}:file`,
          kind: "file",
          name: path.split("/").pop() || path,
          mimeType: mimeFor(path),
          content,
          untrusted: ctx.tainted,
        });
        return {
          content: `Wrote ${path} (${new TextEncoder().encode(content).length.toLocaleString("en")} bytes).`,
          untrusted: false,
          ...(kept ? { artifactId: kept.id } : {}),
        };
      },
    }),
    defineTool({
      name: "files.list",
      description:
        "List a folder on your computer: names, sizes and when each changed. /workspace by default.",
      input: z.object({ path: z.string().min(1).max(4_096).default(".") }),
      annotations: { readOnly: true, idempotent: true },
      async run({ path }, ctx) {
        const { entries, truncated } = await (
          await computer(sandbox, ctx)
        ).listFiles(ctx.agentId, path);
        if (entries.length === 0) return { content: `${path} is empty.`, untrusted: true };
        const rows = [...entries]
          .sort(
            (a, b) =>
              Number(b.type === "directory") - Number(a.type === "directory") ||
              a.name.localeCompare(b.name),
          )
          .map((e) =>
            e.type === "directory"
              ? `${e.name}/`
              : `${e.name}  ${e.size.toLocaleString("en")} B  ${e.modifiedAt.slice(0, 16).replace("T", " ")}`,
          );
        return {
          content: `${rows.join("\n")}${truncated ? "\n…[only the first 1,000 entries]" : ""}`,
          untrusted: true,
        };
      },
    }),
  ];
}
