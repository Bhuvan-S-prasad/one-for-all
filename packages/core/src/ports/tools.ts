import type { ArtifactId, ToolCallId } from "../ids";
import type { RunContext, TenantContext } from "../tenant";

/** JSON Schema for a tool's input, as produced by zod or an MCP server. */
export type JsonSchema = Record<string, unknown>;

/** Risk hints. MCP annotations map onto these; built-ins declare them directly. */
export interface ToolAnnotations {
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  /** Sends data outside the system (email, post, share, HTTP to a new domain). */
  readonly outbound?: boolean;
  readonly idempotent?: boolean;
  /**
   * The argument holding an address this call opens (e.g. `url`). In a run
   * that read untrusted content, an address the run was not given needs
   * approval (§10.3): it could carry data out.
   */
  readonly opensUrl?: string;
}

export type ToolSourceKind = "builtin" | "mcp" | "sandbox";

export interface ToolDescriptor {
  /** `app.action`, e.g. `gmail.create_draft`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: ToolAnnotations;
  readonly source: ToolSourceKind;
}

export interface ToolCallContext extends RunContext {
  readonly toolCallId: ToolCallId;
  /** `runId:step`, stable across retries (ADR-0015). */
  readonly idempotencyKey: string;
}

export interface ToolResult {
  readonly content: unknown;
  /** True when the content came from outside the system; marks the run tainted. */
  readonly untrusted: boolean;
  /** Set when large output was stored as an artifact instead of returned inline. */
  readonly artifactId?: ArtifactId;
}

export interface ToolSource {
  listTools(ctx: TenantContext): Promise<ToolDescriptor[]>;
  call(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolResult>;
}
