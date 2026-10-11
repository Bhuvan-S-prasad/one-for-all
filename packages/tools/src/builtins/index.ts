import type {
  MemoryStore,
  SandboxProvider,
  Scheduler,
  SkillLibrary,
  TeamDirectory,
} from "@ofa/core";
import type { ToolDefinition } from "../define";
import { artifactsReadTool } from "./artifacts";
import { browserTools, fileTools, shellTool, useSavedLoginTool } from "./computer";
import { desktopTools } from "./desktop";
import { recallTool, rememberTool, todoTool } from "./memory";
import { remindMeTool, scheduleTaskTool } from "./schedule";
import { runSkillTool, saveSkillTool } from "./skills";
import { loadToolkitTool } from "./toolkits";
import { delegateTaskTool, messageAgentTool } from "./team";
import { readUrlTool, webSearchTool, type Fetcher, type WebSearchProvider } from "./web";

export interface BuiltinToolDeps {
  readonly memory: MemoryStore;
  readonly search: WebSearchProvider | null;
  readonly fetcher?: Fetcher;
  /** The agents' computer (M3); null when this server has none. */
  readonly sandbox?: SandboxProvider | null;
  /**
   * The other agents a run can hand work to (M5.01) or message (M5.03);
   * without it, `delegate_task` and `message_agent` are never listed.
   */
  readonly team?: TeamDirectory | null;
  /** Tasks and reminders for later (M5.07); without it, those tools are never listed. */
  readonly scheduler?: Scheduler | null;
  /** Saved procedures (M5.08); without it, the skill tools are never listed. */
  readonly skills?: SkillLibrary | null;
}

/**
 * The built-in tools (ARCHITECTURE.md §9.3): web and memory (M2), the
 * computer (M3), working with other agents and on the clock (M5).
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
    ...desktopTools(deps.sandbox ?? null),
    artifactsReadTool(),
    loadToolkitTool(),
    delegateTaskTool(deps.team ?? null),
    messageAgentTool(deps.team ?? null),
    scheduleTaskTool(deps.scheduler ?? null),
    remindMeTool(deps.scheduler ?? null),
    runSkillTool(deps.skills ?? null),
    saveSkillTool(deps.skills ?? null),
  ] as unknown as ToolDefinition<never>[];
}
