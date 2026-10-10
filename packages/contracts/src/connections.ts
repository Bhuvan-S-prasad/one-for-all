import { CONNECTION_STATUSES, MCP_AUTH_KINDS } from "@ofa/core";
import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

// Apps reached through MCP servers (ARCHITECTURE.md §9): the servers a
// workspace installed, and the signed-in person's connection to each.

export const connectionSchema = z.object({
  status: z.enum(CONNECTION_STATUSES),
  /** Why it needs signing in again, in plain words. */
  lastError: z.string().nullable(),
  expiresAt: timestampSchema.nullable(),
  lastUsedAt: timestampSchema.nullable(),
});
export type Connection = z.infer<typeof connectionSchema>;

export const mcpServerSchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  /** The catalog entry it came from; null for a custom server. */
  catalogId: z.string().nullable(),
  url: z.string(),
  auth: z.enum(MCP_AUTH_KINDS),
  /** Where sign-in happens, once known. */
  authOrigin: z.string().nullable(),
  enabled: z.boolean(),
  /** Tools from the server's last tool list; null before anyone signed in. */
  toolCount: z.number().int().nullable(),
  toolsFetchedAt: timestampSchema.nullable(),
  /** The signed-in person's connection; null when they never started one. */
  connection: connectionSchema.nullable(),
  createdAt: timestampSchema,
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export const mcpServerListSchema = z.object({ items: z.array(mcpServerSchema) });
export type McpServerList = z.infer<typeof mcpServerListSchema>;

/** The app part of tool names: `notion` in `notion.search`. */
export const mcpSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "Use lower-case letters, digits and _, starting with a letter");

/**
 * A custom server, outside the reviewed catalog (ADR-0018): it runs with the
 * permissions people grant its tools, so adding one needs an explicit yes.
 */
export const addMcpServerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.url().max(2_000),
  slug: mcpSlugSchema.optional(),
  auth: z.enum(MCP_AUTH_KINDS).default("oauth"),
  acknowledgeRisk: z.literal(true, {
    error: "Custom servers aren't reviewed; confirm that you trust this one",
  }),
});
export type AddMcpServerInput = z.input<typeof addMcpServerSchema>;

export const signInStartSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("redirect"), authorizationUrl: z.url() }),
  z.object({ status: z.literal("connected") }),
]);
export type SignInStartResponse = z.infer<typeof signInStartSchema>;

export const mcpToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }),
});
export const mcpToolListSchema = z.object({ items: z.array(mcpToolSchema) });

/** A connected app's tool as agents see it (`notion.search`), for choosing what an agent may use. */
export const appToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  /** Can't be undone: always asks first, whatever the grant says. */
  destructive: z.boolean(),
});
export type AppTool = z.infer<typeof appToolSchema>;
export const appToolListSchema = z.object({ items: z.array(appToolSchema) });
export type AppToolList = z.infer<typeof appToolListSchema>;

export const toolRefreshSchema = z.object({ count: z.number().int() });
export type ToolRefreshResponse = z.infer<typeof toolRefreshSchema>;
export type McpToolList = z.infer<typeof mcpToolListSchema>;

/** What the provider sends back to the OAuth callback. */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().max(2_000).optional(),
  state: z.string().max(200).optional(),
  iss: z.string().max(2_000).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1_000).optional(),
});

/** A reviewed app in the catalog (ADR-0018). */
export const catalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** `own_client`: an admin first creates an OAuth app with the provider (see `guide`). */
  setup: z.enum(["automatic", "own_client"]),
  guide: z.string().nullable(),
  /** The installed server, if this workspace has added it. */
  serverId: idSchema.nullable(),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;

export const catalogListSchema = z.object({
  items: z.array(catalogItemSchema),
  /** The address to register with providers that need your own OAuth app. */
  redirectUrl: z.url(),
});
export type CatalogList = z.infer<typeof catalogListSchema>;

/** The OAuth app a self-hoster created, for `own_client` entries. */
export const ownClientSchema = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(8).max(500).optional(),
});
export type OwnClientInput = z.infer<typeof ownClientSchema>;

export const installCatalogSchema = z.object({ client: ownClientSchema.optional() });
export type InstallCatalogInput = z.infer<typeof installCatalogSchema>;
