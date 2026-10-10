import type {
  ArtifactInput,
  ArtifactRecord,
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
  /**
   * A saved login for a site (M3.08), decrypted here, at call time, and only
   * for the tool that types it (ADR-0012). Absent when the server has no vault.
   */
  readonly logins?: {
    get(site: string): Promise<{ readonly username: string; readonly password: string } | null>;
  };
  /** The apps whose tools this agent may load (M4.05), for `load_toolkit`. */
  readonly toolkits?: {
    list(): Promise<readonly ToolkitSummary[]>;
  };
  /** This run's artifacts (M3.06); absent when the server keeps none. Reads see only this agent's. */
  readonly artifacts?: {
    put(input: ArtifactInput): Promise<ArtifactRecord>;
    get(id: string): Promise<ArtifactRecord | null>;
    read(id: string): Promise<Uint8Array | null>;
  };
}

/**
 * One connected app's tools (M4.05): an MCP server's tools, plus any we wrote
 * for it (ADR-0029). `app` is the slug that starts every tool name.
 */
export interface Toolkit {
  readonly app: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition<unknown>[];
}

/** What an agent can see of a toolkit before loading it. */
export interface ToolkitSummary {
  readonly app: string;
  readonly name: string;
  readonly description: string;
  /** Tools this agent may use, by name. */
  readonly tools: readonly { readonly name: string; readonly description: string }[];
  readonly loaded: boolean;
}

/** The toolkits a workspace has (its connected apps). */
export interface ToolkitSource {
  toolkits(ctx: RunContext): Promise<readonly Toolkit[]>;
}

export interface ToolRunResult {
  /** Text or JSON for the model. Objects are serialised as JSON. */
  readonly content: string | Record<string, unknown> | unknown[];
  /** True when the content came from outside the system (web pages, email, API data). */
  readonly untrusted: boolean;
  /** An artifact the tool kept (e.g. a copy of a file it wrote), shown to people with the result. */
  readonly artifactId?: string;
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
  /**
   * What this call would do, in plain words, for a person deciding whether to
   * allow it (e.g. `Click the button “Pay now” on shop.example`). Must not
   * change anything. Without it, the card shows the tool and its arguments.
   */
  describe?(args: Input, ctx: ToolRunContext): Promise<string>;
  /**
   * The site this call acts on (`shop.example`), so a person can allow it for
   * the rest of a run that read outside content (M4.07). Must not change
   * anything; null when there is none.
   */
  site?(args: Input, ctx: ToolRunContext): Promise<string | null>;
  /**
   * Top-level text arguments a person may change before approving a held
   * call (ADR-0030): the message of an email, not the address it goes to.
   * The call then runs with their version, checked against the schema again.
   */
  readonly editable?: readonly string[];
  /** The approval card lists the arguments, because `describe` doesn't say them. */
  readonly showArgs?: boolean;
  /**
   * Called when a run's tool list is made: the description for this run,
   * naming what is there now (the agents it can hand work to), or null to
   * leave the tool out of this run's list. Without it the tool is listed as is.
   */
  listed?(ctx: RunContext): Promise<{ readonly description: string } | null>;
}

/** Argument names that hold words a person writes: a message, a title, a comment. */
const WRITTEN_TEXT =
  /(text|body|content|message|subject|title|description|comment|markdown|summary|notes?|reply|caption)$/i;

/**
 * The text a person may change before approving a call to a tool described
 * by `schema` (ADR-0030): top-level free-text strings with names like
 * `body` or `page_title`. Never identifiers, addresses, enums or patterns.
 */
export function editableTextFields(schema: JsonSchema): string[] {
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.entries(properties)
    .filter(([name, value]) => {
      if (!WRITTEN_TEXT.test(name) || !value || typeof value !== "object") return false;
      const prop = value as Record<string, unknown>;
      const types = Array.isArray(prop.type) ? prop.type : [prop.type];
      return (
        types.includes("string") &&
        types.every((t) => t === "string" || t === "null") &&
        prop.enum === undefined &&
        prop.const === undefined &&
        prop.pattern === undefined &&
        prop.format === undefined
      );
    })
    .map(([name]) => name)
    .slice(0, 10);
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
  /** This registry plus more tools (a workspace's toolkits); later duplicates are dropped. */
  extend(tools: readonly ToolDefinition<unknown>[]): ToolRegistry;
}

export function createToolRegistry(tools: readonly ToolDefinition<never>[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition<unknown>>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    byName.set(tool.name, tool as unknown as ToolDefinition<unknown>);
  }
  const descriptors = tools.map(toDescriptor);
  return {
    extend(more) {
      const extra = more.filter((tool) => !byName.has(tool.name));
      const unique = [...new Map(extra.map((tool) => [tool.name, tool])).values()];
      return createToolRegistry([...tools, ...(unique as unknown as ToolDefinition<never>[])]);
    },
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
