// @ofa/video: the video engine (ADR-0049). It imports nothing from
// One-for-All: One-for-All uses it through `video.*` tools, and it runs on its
// own as a CLI and an MCP server.

export { speechCaptions, type Word } from "./captions";
export {
  createVideoEngine,
  VideoError,
  type RenderResult,
  type Scan,
  type Transcript,
  type VerifyReport,
  type VideoEngine,
  type VideoEngineOptions,
} from "./engine";
export { handleMcpMessage, serveMcp, type McpServerOptions } from "./mcp";
export { beatOffsets, musicMapSchema, planSlots, type MusicMap, type Slot } from "./music";
export {
  parseProbe,
  parseSceneMetadata,
  parseVolume,
  shotsFrom,
  type MediaInfo,
  type Shot,
} from "./parse";
export {
  captionsAss,
  clipCommand,
  clipFilters,
  concatList,
  finalCommand,
  safeFilterPath,
} from "./render";
export { localRunner, quoteArg, quoteCommand, type Runner, type RunResult } from "./runner";
export { STYLES, styleById, type Energy, type Style } from "./styles";
export {
  cutFrames,
  FORMATS,
  inFormat,
  sourceSeconds,
  timelineSchema,
  TIMELINE_VERSION,
  totalFrames,
  type Clip,
  type Effect,
  type FormatName,
  type Timeline,
  type TimelineInput,
} from "./timeline";
export { videoTools, type VideoTool, type VideoToolResult } from "./tools";
