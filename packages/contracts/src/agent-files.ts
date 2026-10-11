import { z } from "zod";

// The Files tab in the computer panel (DT.08, ADR-0042): a person browses an
// agent's files: the workspace it shares with the other agents, or its own
// home. Hidden files and its browser profile are never listed or served.

export const AGENT_FILE_ROOTS = ["workspace", "home"] as const;
export const agentFileRootSchema = z.enum(AGENT_FILE_ROOTS);
export type AgentFileRoot = z.infer<typeof agentFileRootSchema>;

export const agentFileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "directory", "link"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
});
export type AgentFileEntry = z.infer<typeof agentFileEntrySchema>;

export const agentFileListSchema = z.object({
  root: agentFileRootSchema,
  /** Relative to the root; "" for the root itself. */
  path: z.string(),
  entries: z.array(agentFileEntrySchema),
  /** More entries than are listed. */
  truncated: z.boolean(),
});
export type AgentFileList = z.infer<typeof agentFileListSchema>;
