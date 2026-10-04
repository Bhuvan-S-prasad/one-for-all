import type { MemoryStore, SandboxProvider } from "@ofa/core";
import type { ToolDefinition } from "../define";
import { browserTools, fileTools, shellTool } from "./computer";
import { recallTool, rememberTool, todoTool } from "./memory";
import { readUrlTool, webSearchTool, type Fetcher, type WebSearchProvider } from "./web";

export interface BuiltinToolDeps {
  readonly memory: MemoryStore;
  readonly search: WebSearchProvider | null;
  readonly fetcher?: Fetcher;
  /** The agents' computer (M3); null when this server has none. */
  readonly sandbox?: SandboxProvider | null;
}

/** The built-in tools (ARCHITECTURE.md §9.3): web and memory (M2), the computer (M3). */
export function builtinTools(deps: BuiltinToolDeps): ToolDefinition<never>[] {
  return [
    webSearchTool(deps.search),
    readUrlTool(deps.fetcher),
    rememberTool(deps.memory),
    recallTool(deps.memory),
    todoTool(),
    ...browserTools(deps.sandbox ?? null),
    shellTool(deps.sandbox ?? null),
    ...fileTools(deps.sandbox ?? null),
  ] as unknown as ToolDefinition<never>[];
}
