import { toolkitToolName } from "@ofa/core";
import { z } from "zod";
import { defineTool } from "../define";

// Free models have small windows (§7), and one connected app can bring dozens
// of tools: Notion's server offers 46. Large apps stay out of the tool list
// until the agent loads them with this tool; they then stay for the rest of
// the run. The executor rewrites this tool's description each time, so it
// names the apps that are waiting and their tools (M4.05).

export const LOAD_TOOLKIT = "load_toolkit";

/**
 * An app with more tools than this is loaded a few tools at a time: the whole
 * of Notion overflowed the tool budget, so the tools the agent needed never
 * reached it (M4 end-to-end check). §7 keeps the list to about 20.
 */
export const LOAD_ALL_LIMIT = 12;

export function loadToolkitTool() {
  return defineTool({
    name: LOAD_TOOLKIT,
    description: `Load a connected app's tools so you can use them for the rest of this task. For an app with more than ${LOAD_ALL_LIMIT} tools, name the ones this task needs in \`tools\`; you can load more later.`,
    input: z.object({
      app: z.string().min(1).max(40).describe("The app to load, e.g. notion"),
      tools: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(LOAD_ALL_LIMIT)
        .optional()
        .describe('The tools you need from it, e.g. ["search", "create_pages"]'),
    }),
    annotations: { readOnly: true, idempotent: true },
    async run({ app, tools }, ctx) {
      const kits = (await ctx.toolkits?.list()) ?? [];
      const slug = app.trim().toLowerCase();
      const kit = kits.find((k) => k.app === slug);
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
      const line = (t: { name: string; description: string }) =>
        `- ${t.name}: ${t.description.split("\n")[0]?.slice(0, 200)}`;
      if (!tools) {
        // Too many to load whole: say what there is, so the next call picks.
        if (kit.tools.length > LOAD_ALL_LIMIT) {
          throw Object.assign(
            new Error(
              `${kit.name} has ${kit.tools.length} tools, too many to load at once. Call load_toolkit again with app "${kit.app}" and tools: the ones this task needs (up to ${LOAD_ALL_LIMIT}). Its tools:\n${kit.tools.map(line).join("\n")}`,
            ),
            { code: "choose_tools" },
          );
        }
        return {
          content: `${kit.name} is loaded. Its tools, from now on in this task:\n${kit.tools.map(line).join("\n")}`,
          untrusted: false,
        };
      }
      const wanted = tools.map((t) => toolkitToolName(kit.app, t));
      const missing = wanted.filter((name) => !kit.tools.some((t) => t.name === name));
      if (missing.length) {
        throw Object.assign(
          new Error(
            `${kit.name} has no ${missing.join(", ")}. Its tools: ${kit.tools.map((t) => t.name).join(", ")}.`,
          ),
          { code: "unknown_tool" },
        );
      }
      const picked = kit.tools.filter((t) => wanted.includes(t.name));
      return {
        content: `Loaded from ${kit.name}, for the rest of this task:\n${picked.map(line).join("\n")}`,
        untrusted: false,
      };
    },
  });
}
