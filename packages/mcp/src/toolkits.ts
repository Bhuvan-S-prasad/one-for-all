import {
  type ConnectionStore,
  type McpServerRecord,
  type McpToolInfo,
  type RunContext,
  type TenantContext,
  type ToolAnnotations,
} from "@ofa/core";
import {
  defineJsonSchemaTool,
  editableTextFields,
  ToolSchemaError,
  type ToolDefinition,
  type Toolkit,
  type ToolkitSource,
} from "@ofa/tools";
import { CATALOG, type CatalogEntry } from "./catalog";
import type { McpConnections } from "./connections";
import { gmailTools } from "./extras/gmail";

// A workspace's connected apps as toolkits (M4.05): each server's last
// `tools/list`, kept on its row, turned into tools the executor runs like any
// other: checked against the server's own schema, through policy, redacted.
// Calls go out with the sign-in of the person the run works for.

/** Tools we wrote for an app, beside its server's own (ADR-0029). */
const EXTRAS: Record<
  string,
  (serverId: string, mcp: McpConnections, api: string) => readonly ToolDefinition<unknown>[]
> = {
  gmail: gmailTools,
};

/** A server's tool name in our `app.action` form: `notion-search` → `notion.search`. */
export function toolNameFor(slug: string, mcpName: string): string | null {
  let action = mcpName.toLowerCase();
  for (const prefix of [`${slug}-`, `${slug}_`, `${slug}.`]) {
    if (action.startsWith(prefix)) {
      action = action.slice(prefix.length);
      break;
    }
  }
  action = action
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  if (!action) return null;
  return `${slug}.${/^[a-z]/.test(action) ? action : `t_${action}`}`;
}

/**
 * MCP's hints in our terms. Per the spec a tool that isn't read-only is
 * presumed destructive unless it says otherwise; anything that isn't
 * read-only changes something in another app, so it counts as outbound.
 */
export function annotationsFor(info: McpToolInfo): ToolAnnotations {
  const readOnly = info.annotations.readOnlyHint === true;
  return {
    readOnly,
    destructive: !readOnly && info.annotations.destructiveHint !== false,
    idempotent: info.annotations.idempotentHint === true,
    outbound: !readOnly,
  };
}

/** "create_page" → "Create page", for people. */
function sentence(action: string): string {
  const words = action.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface McpToolkits extends ToolkitSource {
  /** Fetch a server's tools again with the person's sign-in, and keep them. */
  refresh(ctx: TenantContext, serverId: string): Promise<number>;
  /** One server's tools as agents see them, from its kept list; null before it has one. */
  forServer(ctx: TenantContext, serverId: string): Promise<Toolkit | null>;
}

export function createMcpToolkits(options: {
  readonly connections: ConnectionStore;
  readonly mcp: McpConnections;
  readonly catalog?: readonly CatalogEntry[];
  /** Told when a tool's schema can't be checked, so it is left out. */
  readonly onSkippedTool?: (server: string, tool: string, reason: string) => void;
}): McpToolkits {
  const { connections, mcp } = options;
  const catalog = options.catalog ?? CATALOG;
  // Compiled toolkits per server, until its tool list changes.
  const compiled = new Map<string, { at: number; kit: Toolkit }>();

  function compile(server: McpServerRecord): Toolkit {
    const entry = catalog.find((e) => e.id === server.catalogId);
    const tools: ToolDefinition<unknown>[] = [];
    const taken = new Set<string>();
    for (const info of server.tools ?? []) {
      const base = toolNameFor(server.slug, info.name);
      if (!base) continue;
      let name = base;
      for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
      try {
        tools.push(
          defineJsonSchemaTool({
            name,
            description: (info.title ? `${info.title}. ${info.description}` : info.description)
              .trim()
              .slice(0, 1_500),
            inputSchema: info.inputSchema,
            annotations: annotationsFor(info),
            source: "mcp",
            // The card names the app and action, then lists the arguments;
            // written text in them can be changed before approving (ADR-0030).
            describe: async () =>
              `Use ${server.name}: ${info.title?.trim() || sentence(name.slice(server.slug.length + 1))}`,
            showArgs: true,
            editable: editableTextFields(info.inputSchema),
            async run(args, ctx) {
              const session = await mcp.connect(ctx, server.id);
              try {
                const result = await session.callTool(info.name, args as Record<string, unknown>);
                if (result.isError) {
                  throw Object.assign(
                    new Error(`${server.name} said: ${result.text.slice(0, 2_000)}`),
                    {
                      code: "app_error",
                    },
                  );
                }
                // Another app's data: the run is tainted from here (§10.3).
                return { content: result.text || "(no output)", untrusted: true };
              } finally {
                await session.close().catch(() => {});
              }
            },
          }),
        );
        taken.add(name);
      } catch (error) {
        if (!(error instanceof ToolSchemaError)) throw error;
        options.onSkippedTool?.(server.slug, info.name, error.message);
      }
    }
    // Only with an API origin to send the sign-in to.
    const api = entry?.apiOrigins?.[0];
    const extras = api ? (EXTRAS[server.catalogId ?? ""]?.(server.id, mcp, api) ?? []) : [];
    for (const extra of extras) {
      if (!taken.has(extra.name)) tools.push(extra);
    }
    return {
      app: server.slug,
      name: server.name,
      description: entry?.description ?? `Tools from ${server.name}.`,
      tools,
    };
  }

  function kitOf(server: McpServerRecord): Toolkit {
    const at = server.toolsFetchedAt?.getTime() ?? 0;
    const cached = compiled.get(server.id);
    if (cached && cached.at === at) return cached.kit;
    const kit = compile(server);
    compiled.set(server.id, { at, kit });
    return kit;
  }

  return {
    async toolkits(ctx: RunContext) {
      const servers = await connections.listServers(ctx);
      return servers.filter((s) => s.enabled && s.tools).map(kitOf);
    },

    async forServer(ctx, serverId) {
      const server = await connections.getServer(ctx, serverId);
      return server?.tools ? kitOf(server) : null;
    },

    async refresh(ctx, serverId) {
      const session = await mcp.connect(ctx, serverId);
      try {
        const tools = await session.listTools();
        await connections.saveServerTools(ctx, serverId, tools);
        return tools.length;
      } finally {
        await session.close().catch(() => {});
      }
    },
  };
}
