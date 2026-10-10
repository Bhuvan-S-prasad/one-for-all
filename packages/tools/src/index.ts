export {
  createToolRegistry,
  defineJsonSchemaTool,
  defineTool,
  editableTextFields,
  inputFromJsonSchema,
  toDescriptor,
  ToolSchemaError,
  type ToolDefinition,
  type ToolRegistry,
  type ToolRunContext,
  type Toolkit,
  type ToolkitSource,
  type ToolkitSummary,
  type ToolRunResult,
  type Validation,
} from "./define";
export { createToolExecutor, type ToolExecutorOptions } from "./executor";
export { builtinTools, type BuiltinToolDeps } from "./builtins/index";
export { artifactsReadTool } from "./builtins/artifacts";
export { LOAD_ALL_LIMIT, LOAD_TOOLKIT, loadToolkitTool } from "./builtins/toolkits";
export { DELEGATE_TASK, delegateTaskTool, MESSAGE_AGENT, messageAgentTool } from "./builtins/team";
export { REMIND_ME, remindMeTool, SCHEDULE_TASK, scheduleTaskTool } from "./builtins/schedule";
export { RUN_SKILL, runSkillTool, SAVE_SKILL, saveSkillTool } from "./builtins/skills";
export {
  browserTools,
  fileTools,
  mimeFor,
  pageText,
  shellTool,
  useSavedLoginTool,
} from "./builtins/computer";
export { htmlTitle, htmlToText } from "./builtins/html";
export { recallTool, rememberTool, todoTool } from "./builtins/memory";
export {
  FetchBlockedError,
  isPrivateAddress,
  safeFetch,
  type SafeResponse,
} from "./builtins/safe-fetch";
export {
  createSearxngProvider,
  READ_CHUNK_CHARS,
  readUrlTool,
  webSearchTool,
  type Fetcher,
  type SearchResult,
  type WebSearchProvider,
} from "./builtins/web";

/** Tool names granted to a new agent by default in M2: read-only research and memory. */
export const DEFAULT_GRANTS = [
  "web.search",
  "web.read_url",
  "remember",
  "recall",
  "todo.write",
] as const;
