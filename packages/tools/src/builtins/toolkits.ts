import { z } from "zod";
import { defineTool } from "../define";

// Free models have small windows (§7), and one connected app can bring dozens
// of tools: Notion's server offers 46. Large apps stay out of the tool list
// until the agent loads them with this tool; they then stay for the rest of
// the run. The executor rewrites this tool's description each time, so it
// names the apps that are waiting (M4.05).

export const LOAD_TOOLKIT = "load_toolkit";

export function loadToolkitTool() {
  return defineTool({
    name: LOAD_TOOLKIT,
    description:
      "Load a connected app's tools so you can use them for the rest of this task. Call it with the app's name, then use its tools.",
    input: z.object({
      app: z.string().min(1).max(40).describe("The app to load, e.g. notion"),
    }),
    annotations: { readOnly: true, idempotent: true },
    async run({ app }, ctx) {
      const kits = (await ctx.toolkits?.list()) ?? [];
      const kit = kits.find((k) => k.app === app.trim().toLowerCase());
      if (!kit) {
        const names = kits.map((k) => k.app).join(", ");
        throw Object.assign(
          new Error(
            names
              ? `There is no app called ${app}. You can load: ${names}.`
              : "No connected apps are available to you.",
          ),
          { code: "unknown_toolkit" },
        );
      }
      const lines = kit.tools.map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`);
      return {
        content: `${kit.name} is loaded. Its tools, from now on in this task:\n${lines.join("\n")}`,
        untrusted: false,
      };
    },
  });
}
