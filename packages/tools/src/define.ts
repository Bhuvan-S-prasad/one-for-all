import type {
  JsonSchema,
  MemoryScope,
  RunContext,
  ToolAnnotations,
  ToolDescriptor,
  ToolSourceKind,
} from "@ofa/core";
import { z } from "zod";

// The tool definition interface (M2.13). A tool declares its schema and risk;
// it never checks permissions itself. The executor does that before `run`
// is called (hard rule 5). Built-in tools declare a zod schema; tools that
// arrive described by JSON Schema (MCP servers, M4) are compiled to one, so
// every call is validated the same way before it runs (M2.29).

export interface ToolRunContext extends RunContext {
  /** `runId:step`: pass it to APIs that accept idempotency keys (ADR-0015). */
  readonly idempotencyKey: string;
  /** The run has read untrusted content; memory written now is unverified. */
  readonly tainted: boolean;
  readonly memoryScopes: readonly MemoryScope[];
}

export interface ToolRunResult {
  /** Text or JSON for the model. Objects are serialised as JSON. */
  readonly content: string | Record<string, unknown> | unknown[];
  /** True when the content came from outside the system (web pages, email, API data). */
  readonly untrusted: boolean;
}

export interface ToolDefinition<Input = unknown> {
  /** `app.action`, snake_case after the dot. */
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<Input>;
  /**
   * The JSON Schema the tool was described with, when it came from outside
   * (MCP). The model is shown this exactly, rather than a round trip of `input`.
   */
  readonly inputSchema?: JsonSchema;
  readonly annotations: ToolAnnotations;
  readonly source?: ToolSourceKind;
  run(args: Input, ctx: ToolRunContext): Promise<ToolRunResult>;
  /**
   * For tools with side effects that are not idempotent: after a crash left
   * the call `in_flight`, check whether it already happened (e.g. look in the
   * Sent folder). Return the result if it did, null if it did not (ADR-0015).
   */
  verify?(args: Input, ctx: ToolRunContext): Promise<ToolRunResult | null>;
}

/** Keeps the input type flowing from the schema into `run`. */
export function defineTool<Input>(tool: ToolDefinition<Input>): ToolDefinition<Input> {
  return tool;
}

/** A tool's JSON Schema could not be turned into a validator. */
export class ToolSchemaError extends Error {
  override readonly name = "ToolSchemaError";
}

/** Older schemas keep shared parts in `definitions`; the converter reads `$defs`. */
function withDefs(schema: JsonSchema): JsonSchema {
  if (!("definitions" in schema) || "$defs" in schema) return schema;
  const moved = JSON.stringify(schema).replaceAll('"#/definitions/', '"#/$defs/');
  const { definitions, ...rest } = JSON.parse(moved) as JsonSchema & { definitions: unknown };
  return { ...rest, $defs: definitions };
}

/**
 * A validator for a JSON Schema. Throws `ToolSchemaError` for a schema it
 * cannot check, so a bad tool fails when it is registered, not mid-run.
 */
export function inputFromJsonSchema(schema: JsonSchema): z.ZodType {
  try {
    return z.fromJSONSchema(withDefs(schema) as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    throw new ToolSchemaError(
      `Unsupported input schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A tool described by JSON Schema rather than zod, as MCP servers describe theirs. */
export function defineJsonSchemaTool(
  tool: Omit<ToolDefinition<unknown>, "input" | "inputSchema"> & {
    readonly inputSchema: JsonSchema;
  },
): ToolDefinition<unknown> {
  let input: z.ZodType;
  try {
    input = inputFromJsonSchema(tool.inputSchema);
  } catch (error) {
    throw new ToolSchemaError(`${tool.name}: ${(error as Error).message}`);
  }
  return { ...tool, input };
}

export function toDescriptor(tool: ToolDefinition<never>): ToolDescriptor {
  const { $schema: _ignored, ...schema } = (tool.inputSchema ??
    z.toJSONSchema(tool.input as z.ZodType, { target: "draft-7" })) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
    annotations: tool.annotations,
    source: tool.source ?? "builtin",
  };
}

export type Validation =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

export interface ToolRegistry {
  get(name: string): ToolDefinition<unknown> | undefined;
  descriptors(): readonly ToolDescriptor[];
  /** Check arguments against the tool's schema; the message is written for the model. */
  validate(name: string, args: unknown): Validation;
}

export function createToolRegistry(tools: readonly ToolDefinition<never>[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition<unknown>>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    byName.set(tool.name, tool as unknown as ToolDefinition<unknown>);
  }
  const descriptors = tools.map(toDescriptor);
  return {
    get: (name) => byName.get(name),
    descriptors: () => descriptors,
    validate(name, args) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, message: `No tool named ${name}` };
      const parsed = tool.input.safeParse(args ?? {});
      if (parsed.success) return { ok: true, value: parsed.data };
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return { ok: false, message: issues.join("; ") };
    },
  };
}
