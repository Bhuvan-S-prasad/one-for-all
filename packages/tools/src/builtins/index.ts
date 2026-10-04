import type { MemoryStore } from "@ofa/core";
import type { ToolDefinition } from "../define";
import { recallTool, rememberTool, todoTool } from "./memory";
import { readUrlTool, webSearchTool, type Fetcher, type WebSearchProvider } from "./web";

export interface BuiltinToolDeps {
  readonly memory: MemoryStore;
  readonly search: WebSearchProvider | null;
  readonly fetcher?: Fetcher;
}

/** The built-in tools available in M2 (ARCHITECTURE.md §9.3). */
export function builtinTools(deps: BuiltinToolDeps): ToolDefinition<never>[] {
  return [
    webSearchTool(deps.search),
    readUrlTool(deps.fetcher),
    rememberTool(deps.memory),
    recallTool(deps.memory),
    todoTool(),
  ] as unknown as ToolDefinition<never>[];
}
