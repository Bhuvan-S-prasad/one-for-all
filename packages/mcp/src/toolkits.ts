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
  keepDownload,
  MAX_DOWNLOAD_BYTES,
  mediaLinks,
  safeDownload,
  toDescriptor,
  ToolSchemaError,
  type ToolDefinition,
  type Toolkit,
  type ToolkitSource,
  type ToolRunContext,
  type ToolRunResult,
} from "@ofa/tools";
import { CATALOG, type CatalogEntry } from "./catalog";
import type { McpCallResult, McpConnections } from "./connections";
import { gmailTools } from "./extras/gmail";

// A workspace's connected apps as toolkits (M4.05): each server's last
// `tools/list`, kept on its row, turned into tools the executor runs like any
// other: checked against the server's own schema, through policy, redacted.
// Calls go out with the sign-in of the person the run works for.

/** Tools we wrote for an app: beside its server's own (ADR-0029), or all of them for an API app (ADR-0031). */
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

/**
 * Actions of a media app that only look: checking a job, listing models,
 * reading the balance. Servers rarely mark these read-only, but they spend
 * nothing, so they carry no cost (polling a job must not ask each time).
 */
const FREE_ACTION =
  /(^|_)(get|list|status|check|poll|fetch|retrieve|search|describe|info|balance|credits|history|wait)(_|$)/;

/** What a call of this tool costs, for a media app (ADR-0048); undefined when it is free. */
export function costFor(
  entry: CatalogEntry | undefined,
  action: string,
  annotations: ToolAnnotations,
): number | undefined {
  if (!entry?.media || annotations.readOnly || FREE_ACTION.test(action)) return undefined;
  return entry.media.costPerCallUsd;
}

/** Most files kept from one call. */
const MAX_KEPT = 8;

/**
 * Keep what a media app made (EN.13): inline pictures and sounds, links it
 * returned as files, and, for a media app, links to media in its text.
 * Provider links expire, so the files are downloaded into the run's own.
 */
async function keepMedia(
  ctx: ToolRunContext,
  result: McpCallResult,
  entry: CatalogEntry | undefined,
): Promise<{ lines: string[]; artifactId?: string }> {
  if (!ctx.artifacts) return { lines: [] };
  const lines: string[] = [];
  let artifactId: string | undefined;
  let n = 0;
  for (const item of result.media ?? []) {
    if (n >= MAX_KEPT) break;
    const ext = item.mimeType.split("/")[1]?.replace(/[^a-z0-9]+/g, "") || "bin";
    const kept = await ctx.artifacts.put({
      key: `${ctx.idempotencyKey}:media:${n}`,
      kind: "file",
      name: `media-${n + 1}.${ext}`,
      mimeType: item.mimeType,
      content: item.data,
      untrusted: true,
    });
    n += 1;
    artifactId ??= kept.id;
    lines.push(`Kept ${kept.name} (${kept.mimeType}); it shows under your reply.`);
  }
  const links = [
    ...new Set([
      ...(result.links ?? []).map((l) => l.uri),
      ...(entry?.media ? mediaLinks(result.text) : []),
    ]),
  ];
  for (const url of links) {
    if (n >= MAX_KEPT) break;
    try {
      const got = await safeDownload(url, { maxBytes: MAX_DOWNLOAD_BYTES });
      const kept = await keepDownload(ctx, got, {
        key: `${ctx.idempotencyKey}:media:${n}`,
        untrusted: true,
      });
      n += 1;
      artifactId ??= kept.id;
      lines.push(`Kept ${kept.name} (${kept.mimeType}) from ${url}; it shows under your reply.`);
    } catch (error) {
      lines.push(`Couldn't keep ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { lines, ...(artifactId ? { artifactId } : {}) };
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

  const entryOf = (server: McpServerRecord) => catalog.find((e) => e.id === server.catalogId);
  /** The tools we wrote for this app, if any. */
  function extrasOf(server: McpServerRecord): readonly ToolDefinition<unknown>[] {
    // Only with an API origin to send the sign-in to.
    const api = entryOf(server)?.apiOrigins?.[0];
    return api ? (EXTRAS[server.catalogId ?? ""]?.(server.id, mcp, api) ?? []) : [];
  }

  function compile(server: McpServerRecord): Toolkit {
    const entry = entryOf(server);
    const tools: ToolDefinition<unknown>[] = [];
    const taken = new Set<string>();
    // An API app has no server tools; its kept list only names ours.
    for (const info of entry?.kind === "api" ? [] : (server.tools ?? [])) {
      const base = toolNameFor(server.slug, info.name);
      if (!base) continue;
      let name = base;
      for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
      const action = name.slice(server.slug.length + 1);
      const annotations = annotationsFor(info);
      const costUsd = costFor(entry, action, annotations);
      const timeoutMs = entry?.media ? entry.media.callTimeoutSeconds * 1_000 : undefined;
      try {
        tools.push(
          defineJsonSchemaTool({
            name,
            description: (info.title ? `${info.title}. ${info.description}` : info.description)
              .trim()
              .slice(0, 1_500),
            inputSchema: info.inputSchema,
            annotations: costUsd === undefined ? annotations : { ...annotations, costUsd },
            source: "mcp",
            ...(timeoutMs ? { timeoutMs } : {}),
            // The card names the app and action, then lists the arguments;
            // written text in them can be changed before approving (ADR-0030).
            describe: async () =>
              [
                `Use ${server.name}: ${info.title?.trim() || sentence(action)}`,
                ...(costUsd !== undefined && entry?.media
                  ? [
                      `Uses ${server.name} credits: about $${costUsd.toFixed(2)} (estimate: ${entry.media.costNote})`,
                    ]
                  : []),
              ].join("\n"),
            showArgs: true,
            editable: editableTextFields(info.inputSchema),
            async run(args, ctx) {
              const session = await mcp.connect(ctx, server.id);
              try {
                const result = await session.callTool(
                  info.name,
                  args as Record<string, unknown>,
                  timeoutMs ? { timeoutMs } : undefined,
                );
                if (result.isError) {
                  throw Object.assign(
                    new Error(`${server.name} said: ${result.text.slice(0, 2_000)}`),
                    {
                      code: "app_error",
                    },
                  );
                }
                const kept = await keepMedia(ctx, result, entry);
                const text = result.text || (kept.lines.length ? "" : "(no output)");
                // Another app's data: the run is tainted from here (§10.3).
                const out: ToolRunResult = {
                  content: [text, ...kept.lines].filter(Boolean).join("\n"),
                  untrusted: true,
                  ...(kept.artifactId ? { artifactId: kept.artifactId } : {}),
                };
                return out;
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
    for (const extra of extrasOf(server)) {
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
      const server = await connections.getServer(ctx, serverId);
      if (server && entryOf(server)?.kind === "api") {
        // Nothing to ask: keep our own tools' list, so the app shows what it offers.
        const tools = extrasOf(server).map((tool) => {
          const d = toDescriptor(tool as never);
          return {
            name: tool.name.slice(server.slug.length + 1),
            description: tool.description,
            inputSchema: d.inputSchema,
            annotations: {
              readOnlyHint: tool.annotations.readOnly === true,
              destructiveHint: tool.annotations.destructive === true,
            },
          };
        });
        await connections.saveServerTools(ctx, serverId, tools);
        return tools.length;
      }
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
