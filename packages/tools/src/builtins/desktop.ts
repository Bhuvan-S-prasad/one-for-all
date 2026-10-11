import type { SandboxProvider } from "@ofa/core";
import { z } from "zod";
import { defineTool } from "../define";

// The agent's desktop (ADR-0040, ADR-0041). `desktop.open` shows a file or
// folder in its app, so a person watching sees the result (a report in
// AbiWord, a sheet in Gnumeric). Only apps that send nothing anywhere, never
// the browser, so opening isn't outbound (ADR-0043).

const APP_NAMES: Record<string, string> = {
  abiword: "AbiWord",
  gnumeric: "Gnumeric",
  feh: "the image viewer",
  mousepad: "the editor",
  pcmanfm: "Files",
};

export function desktopTools(sandbox: SandboxProvider | null) {
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
        if (!sandbox) {
          throw Object.assign(
            new Error("This server has no computer for agents yet (SANDBOX_URL)."),
            { code: "not_configured" },
          );
        }
        const { app } = await (await sandbox.acquire(ctx)).openFile(ctx.agentId, path);
        return {
          content: `Opened ${path} in ${APP_NAMES[app] ?? app} on your desktop.`,
          untrusted: false,
        };
      },
    }),
  ];
}
