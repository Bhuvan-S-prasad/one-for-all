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
export type McpToolList = z.infer<typeof mcpToolListSchema>;

/** What the provider sends back to the OAuth callback. */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().max(2_000).optional(),
  state: z.string().max(200).optional(),
  iss: z.string().max(2_000).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1_000).optional(),
});
