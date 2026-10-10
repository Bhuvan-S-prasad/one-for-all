import type { MemoryStore, SandboxProvider, TeamDirectory } from "@ofa/core";
import type { ToolDefinition } from "../define";
import { artifactsReadTool } from "./artifacts";
import { browserTools, fileTools, shellTool, useSavedLoginTool } from "./computer";
import { recallTool, rememberTool, todoTool } from "./memory";
import { loadToolkitTool } from "./toolkits";
import { delegateTaskTool } from "./team";
import { readUrlTool, webSearchTool, type Fetcher, type WebSearchProvider } from "./web";

export interface BuiltinToolDeps {
  readonly memory: MemoryStore;
  readonly search: WebSearchProvider | null;
  readonly fetcher?: Fetcher;
  /** The agents' computer (M3); null when this server has none. */
  readonly sandbox?: SandboxProvider | null;
  /** The other agents a run can hand work to (M5.01); without it, `delegate_task` is never listed. */
  readonly team?: TeamDirectory | null;
}

/**
 * The built-in tools (ARCHITECTURE.md §9.3): web and memory (M2), the
 * computer (M3), handing work to another agent (M5).
 */
export function builtinTools(deps: BuiltinToolDeps): ToolDefinition<never>[] {
  return [
    webSearchTool(deps.search),
    readUrlTool(deps.fetcher),
    rememberTool(deps.memory),
    recallTool(deps.memory),
    todoTool(),
    ...browserTools(deps.sandbox ?? null),
    useSavedLoginTool(deps.sandbox ?? null),
    shellTool(deps.sandbox ?? null),
    ...fileTools(deps.sandbox ?? null),
    artifactsReadTool(),
    loadToolkitTool(),
    delegateTaskTool(deps.team ?? null),
  ] as unknown as ToolDefinition<never>[];
}
