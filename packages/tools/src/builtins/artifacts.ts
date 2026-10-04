import { artifactUri, parseArtifactUri } from "@ofa/core";
import { z } from "zod";
import { defineTool } from "../define";
import { READ_CHUNK_CHARS } from "./web";

// Reopening long output (M3.06, ARCHITECTURE.md §7): when a result is too long
// for the context, the agent sees its start and an `artifact://` handle, and
// reads on here. A platform tool: every agent may use it, for its own
// artifacts only.

export function artifactsReadTool() {
  return defineTool({
    name: "artifacts.read",
    description: `Read saved output by its artifact:// handle, ${READ_CHUNK_CHARS.toLocaleString("en")} characters at a time.`,
    input: z.object({
      uri: z.string().min(1).max(200).describe("e.g. artifact://3f2a…"),
      from: z.number().int().min(0).default(0).describe("Character to start from"),
    }),
    annotations: { readOnly: true, idempotent: true },
    async run({ uri, from }, ctx) {
      const id = parseArtifactUri(uri);
      const found = id && ctx.artifacts ? await ctx.artifacts.get(id) : null;
      const bytes = found && ctx.artifacts ? await ctx.artifacts.read(found.id) : null;
      if (!found || !bytes) {
        throw Object.assign(new Error(`No saved output at ${uri}`), { code: "not_found" });
      }
      const text = new TextDecoder().decode(bytes);
      const chunk = text.slice(from, from + READ_CHUNK_CHARS);
      const end = from + chunk.length;
      const more =
        end < text.length
          ? `\n…[characters ${from}–${end} of ${text.length}; call again with from: ${end}]`
          : "";
      return {
        content: `${artifactUri(found.id)} (${found.name})\n\n${chunk || "(nothing more)"}${more}`,
        untrusted: found.untrusted,
      };
    },
  });
}
