import type {
  AgentDesktop,
  DesktopScreenshot,
  DesktopSnapshot,
  RunContext,
  SandboxProvider,
} from "@ofa/core";
import { z } from "zod";
import { defineTool, type ToolRunContext } from "../define";

// The agent's desktop (ADR-0040, ADR-0041). `desktop.open` shows a file or
// folder in its app, so a person watching sees the result (a report in
// AbiWord, a sheet in Gnumeric). Only apps that send nothing anywhere, never
// the browser, so opening isn't outbound (ADR-0043). The other tools read
// and drive desktop apps through their accessibility tree, as the browser
// tools do pages: an outline with numbered controls. Acting is outbound.
// For apps the tree can't read (a canvas, a document view), the screenshot
// fallback (ADR-0041, DT.11) shows the model the screen and lets it click at
// a point, as fractions of the screen: free vision models point far better
// that way than in pixels (the vision spike). Those tools are listed only
// when the run's model can see images.

const APP_NAMES: Record<string, string> = {
  abiword: "AbiWord",
  gnumeric: "Gnumeric",
  feh: "the image viewer",
  mousepad: "the editor",
  pcmanfm: "Files",
};

/** Desktop outlines are paged like web pages. */
const DESKTOP_CHUNK_CHARS = 12_000;

function notConfigured(): never {
  throw Object.assign(new Error("This server has no computer for agents yet (SANDBOX_URL)."), {
    code: "not_configured",
  });
}

async function desktopOf(
  sandbox: SandboxProvider | null,
  ctx: ToolRunContext,
): Promise<AgentDesktop> {
  if (!sandbox) notConfigured();
  return (await sandbox.acquire(ctx)).desktopApps(ctx.agentId);
}

/** A desktop snapshot as tool output, a chunk at a time. */
export function desktopText(snapshot: DesktopSnapshot, from = 0): string {
  const chunk = snapshot.outline.slice(from, from + DESKTOP_CHUNK_CHARS);
  const end = from + chunk.length;
  const more =
    end < snapshot.outline.length
      ? `\n…[characters ${from}–${end} of ${snapshot.outline.length}; call desktop.snapshot with from: ${end} to read more]`
      : "";
  return `Window in front: ${snapshot.title || "(none)"}\n\n${chunk || "(nothing more)"}${more}`;
}

/** "the push button “Save” in “ai.docx - AbiWord”", for approval cards. */
async function target(sandbox: SandboxProvider | null, ctx: ToolRunContext, ref: number) {
  try {
    const { window, element } = await (await desktopOf(sandbox, ctx)).describe(ref);
    const what = element.name ? `the ${element.role} “${element.name}”` : `the ${element.role}`;
    return window ? `${what} in “${window}”` : what;
  } catch {
    return `control [${ref}] on its desktop`;
  }
}

const ref = z.number().int().min(1).max(100_000).describe("The control's number from the snapshot");

/** A screenshot as tool output: a line of text, and the image the model sees after it. */
function seen(shot: DesktopScreenshot, lead: string) {
  return {
    content: `${lead} Window in front: ${shot.title || "(none)"}. The screenshot follows; point with fractions of the screen (x 0.5, y 0.5 is the middle).`,
    // What the screen shows may come from outside.
    untrusted: true,
    image: { data: shot.data, mediaType: shot.mediaType },
  };
}

const fraction = (axis: string) =>
  z
    .number()
    .min(0)
    .max(4_000)
    .describe(`Fraction of the screen from the ${axis} edge, 0 to 1 (pixels if above 1)`);

export function desktopTools(
  sandbox: SandboxProvider | null,
  /** Whether the run's model can see images; without it the screenshot tools are never listed. */
  vision?: (ctx: RunContext) => Promise<boolean>,
) {
  /** Listed only for runs whose model can see images (DT.11). */
  const ifVision = (description: string) => async (ctx: RunContext) =>
    vision && (await vision(ctx)) ? { description } : null;
  const screenshotHelp =
    "See your desktop as a screenshot, for apps desktop.snapshot can't read (a drawing, a document view, a game). Prefer desktop.snapshot when it shows what you need: it is faster and exact.";
  const clickHelp =
    "Click at a point on your desktop, as fractions of the screen from the top-left corner (x 0.5, y 0.5 is the middle), from your latest screenshot. Set double for a double-click. Returns a new screenshot.";
  const typeHelp =
    "Type text into whatever has the keyboard on your desktop, at its cursor (click the spot first), and press Enter afterwards if submit is set. Only for apps desktop.snapshot can't read: for a field the snapshot lists, use desktop.type, which puts the text at its end or replaces it. Returns a new screenshot. Never type passwords.";
  // What an app shows may come from outside (a document, a web page saved to a file).
  const shown = (snapshot: DesktopSnapshot) => ({
    content: desktopText(snapshot),
    untrusted: true,
  });
  return [
    defineTool({
      name: "desktop.open",
      description:
        "Open a file or folder on your desktop, in its app: Word files in AbiWord, spreadsheets and CSV in Gnumeric, images in a viewer, text in the editor, folders in Files. Use it to show the person what you made. Paths are relative to /workspace unless they start with / or ~ (your own folder).",
      input: z.object({ path: z.string().min(1).max(4_096) }),
      annotations: { idempotent: true },
      async describe({ path }) {
        return `Open ${path} on its desktop`;
      },
      async run({ path }, ctx) {
        if (!sandbox) notConfigured();
        const { app } = await (await sandbox.acquire(ctx)).openFile(ctx.agentId, path);
        return {
          content: `Opened ${path} in ${APP_NAMES[app] ?? app} on your desktop.`,
          untrusted: false,
        };
      },
    }),
    defineTool({
      name: "desktop.snapshot",
      description:
        "See the apps on your desktop: the window in front as an outline (menus, buttons, fields and their values, each with a number in brackets) and the other windows one line each. Use the numbers with desktop.click and desktop.type. For web pages use the browser tools instead.",
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
        const snapshot = await (await desktopOf(sandbox, ctx)).snapshot();
        return { content: desktopText(snapshot, from), untrusted: true };
      },
    }),
    defineTool({
      name: "desktop.click",
      description:
        "Click a control on your desktop by its number: a button, menu, menu item, tab or checkbox. Clicking a window's line brings it to the front. Returns the desktop afterwards.",
      input: z.object({ ref }),
      annotations: { outbound: true },
      async run(args, ctx) {
        return shown(await (await desktopOf(sandbox, ctx)).click(args.ref));
      },
      async describe(args, ctx) {
        return `Click ${await target(sandbox, ctx, args.ref)}`;
      },
    }),
    defineTool({
      name: "desktop.type",
      description:
        "Type text into a field on your desktop by its number. Without clear, the text goes at the end of what is there (start it with \\n to add a new line); set clear to replace it all. Set submit to press Enter afterwards. In Gnumeric, type a cell like B3 into the cell-name field with clear and submit, then the value into the edit line with clear and submit. Never type passwords.",
      input: z.object({
        ref,
        text: z.string().max(5_000),
        clear: z.boolean().default(false),
        submit: z.boolean().default(false),
      }),
      annotations: { outbound: true },
      async run({ ref: control, text, clear, submit }, ctx) {
        return shown(await (await desktopOf(sandbox, ctx)).type(control, text, { clear, submit }));
      },
      async describe({ ref: control, text, submit }, ctx) {
        const shownText = text.length > 300 ? `${text.slice(0, 299)}…` : text;
        return `Type “${shownText}” into ${await target(sandbox, ctx, control)}${submit ? ", then press Enter" : ""}`;
      },
    }),
    defineTool({
      name: "desktop.press",
      description:
        "Press keys in the window in front on your desktop, e.g. ctrl+s to save, Return, Escape, Tab or alt+F4. Several are separated by spaces.",
      input: z.object({
        keys: z
          .string()
          .regex(/^[A-Za-z0-9_+ -]{1,100}$/, "Keys look like ctrl+s, Return or alt+F4"),
      }),
      annotations: { outbound: true },
      async run({ keys }, ctx) {
        return shown(await (await desktopOf(sandbox, ctx)).press(keys));
      },
      async describe({ keys }) {
        return `Press ${keys} on its desktop`;
      },
    }),
    defineTool({
      name: "desktop.screenshot",
      description: screenshotHelp,
      input: z.object({}),
      annotations: { readOnly: true, idempotent: true },
      listed: ifVision(screenshotHelp),
      async run(_args, ctx) {
        return seen(await (await desktopOf(sandbox, ctx)).screenshot(), "Your desktop now.");
      },
    }),
    defineTool({
      name: "desktop.click_at",
      description: clickHelp,
      input: z.object({
        x: fraction("left"),
        y: fraction("top"),
        double: z.boolean().default(false),
      }),
      annotations: { outbound: true },
      listed: ifVision(clickHelp),
      async run({ x, y, double }, ctx) {
        const shot = await (await desktopOf(sandbox, ctx)).clickAt(x, y, { double });
        const at = shot.clicked ? ` at pixel (${shot.clicked[0]}, ${shot.clicked[1]})` : "";
        return seen(shot, `${double ? "Double-clicked" : "Clicked"}${at}.`);
      },
      async describe({ x, y, double }) {
        const where =
          x <= 1 && y <= 1
            ? `${Math.round(x * 100)}% across, ${Math.round(y * 100)}% down`
            : `pixel (${x}, ${y})`;
        return `${double ? "Double-click" : "Click"} on its desktop at ${where}`;
      },
    }),
    defineTool({
      name: "desktop.type_text",
      description: typeHelp,
      input: z.object({ text: z.string().max(5_000), submit: z.boolean().default(false) }),
      annotations: { outbound: true },
      listed: ifVision(typeHelp),
      async run({ text, submit }, ctx) {
        const shot = await (await desktopOf(sandbox, ctx)).typeText(text, { submit });
        return seen(shot, `Typed ${text.length} characters${submit ? " and pressed Enter" : ""}.`);
      },
      async describe({ text, submit }) {
        const shown = text.length > 300 ? `${text.slice(0, 299)}…` : text;
        return `Type “${shown}” on its desktop${submit ? ", then press Enter" : ""}`;
      },
    }),
  ];
}
