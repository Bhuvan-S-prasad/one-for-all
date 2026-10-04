export {
  createToolRegistry,
  defineJsonSchemaTool,
  defineTool,
  inputFromJsonSchema,
  toDescriptor,
  ToolSchemaError,
  type ToolDefinition,
  type ToolRegistry,
  type ToolRunContext,
  type ToolRunResult,
  type Validation,
} from "./define";
export { createToolExecutor, type ToolExecutorOptions } from "./executor";
export { builtinTools, type BuiltinToolDeps } from "./builtins/index";
export { browserTools, fileTools, pageText, shellTool } from "./builtins/computer";
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
