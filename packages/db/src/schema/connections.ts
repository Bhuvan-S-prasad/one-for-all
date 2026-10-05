import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { createdAt, id, timestampAt, updatedAt } from "./columns";
import { workspaceId } from "./tenancy";

/**
 * An MCP server this workspace can connect to (ARCHITECTURE.md §9.2): a
 * reviewed catalog entry with its pinned URL, or a custom server the owner
 * added behind a warning (ADR-0018). `slug` is the app part of its tool
 * names (`notion` in `notion.search`).
 *
 * The OAuth client (registered automatically, or the self-hoster's own for
 * Google) is stored as one envelope, like a secret (ADR-0012): it can hold a
 * client secret. `auth_origin` pins the authorization server's origin, so a
 * server that later points sign-in elsewhere is refused.
 */
export const mcpServer = pgTable(
  "mcp_server",
  {
    id: id(),
    workspaceId: workspaceId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The catalog entry's id (`notion`); null for a custom server. */
    catalogId: text("catalog_id"),
    url: text("url").notNull(),
    auth: text("auth").notNull().default("oauth"),
    authOrigin: text("auth_origin"),
    clientCiphertext: text("client_ciphertext"),
    clientKeyCiphertext: text("client_key_ciphertext"),
    /** Fingerprint of the vault key that wrapped `client_key_ciphertext`. */
    clientKeyId: text("client_key_id"),
    enabled: boolean("enabled").notNull().default(true),
    /** The last `tools/list` answer, as the server gave it (M4.05). */
    tools: jsonb("tools").$type<unknown[]>(),
    toolsFetchedAt: timestampAt("tools_fetched_at"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mcp_server_workspace_slug_uq").on(t.workspaceId, t.slug),
    uniqueIndex("mcp_server_workspace_catalog_uq")
      .on(t.workspaceId, t.catalogId)
      .where(sql`${t.catalogId} is not null`),
    // Target for composite foreign keys that keep references inside one workspace.
    unique("mcp_server_workspace_id_uq").on(t.workspaceId, t.id),
    check("mcp_server_slug_ck", sql`${t.slug} ~ '^[a-z][a-z0-9_]{0,31}$'`),
    check("mcp_server_auth_ck", sql`${t.auth} in ('oauth', 'none')`),
    check(
      "mcp_server_client_ck",
      sql`(${t.clientCiphertext} is null) = (${t.clientKeyCiphertext} is null)
        and (${t.clientCiphertext} is null) = (${t.clientKeyId} is null)`,
    ),
  ],
);

/**
 * One person's sign-in to an MCP server (ARCHITECTURE.md §9.1). Tokens are
 * one envelope, decrypted only in the tool executor (hard rule 4). While the
 * OAuth flow is under way (`pending`), the envelope holds the PKCE verifier
 * and `oauth_state` finds the row when the provider redirects back.
 * `expires_at` is the access token's, for background refresh (M4.06).
 */
export const connection = pgTable(
  "connection",
  {
    id: id(),
    workspaceId: workspaceId(),
    mcpServerId: uuid("mcp_server_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    /** Which account, for display (`sam@example.com`). */
    account: text("account"),
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    credentialsCiphertext: text("credentials_ciphertext"),
    keyCiphertext: text("key_ciphertext"),
    /** Fingerprint of the vault key that wrapped `key_ciphertext`. */
    keyId: text("key_id"),
    oauthState: text("oauth_state"),
    expiresAt: timestampAt("expires_at"),
    refreshedAt: timestampAt("refreshed_at"),
    lastUsedAt: timestampAt("last_used_at"),
    /** Why it needs signing in again, in plain words; never a token or a raw response. */
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "connection_mcp_server_fk",
      columns: [t.workspaceId, t.mcpServerId],
      foreignColumns: [mcpServer.workspaceId, mcpServer.id],
    }).onDelete("cascade"),
    uniqueIndex("connection_server_user_uq").on(t.mcpServerId, t.userId),
    uniqueIndex("connection_oauth_state_uq").on(t.oauthState),
    index("connection_workspace_expires_idx").on(t.workspaceId, t.expiresAt),
    check("connection_status_ck", sql`${t.status} in ('pending', 'active', 'needs_reauth')`),
    check(
      "connection_credentials_ck",
      sql`(${t.credentialsCiphertext} is null) = (${t.keyCiphertext} is null)
        and (${t.credentialsCiphertext} is null) = (${t.keyId} is null)`,
    ),
    check(
      "connection_active_ck",
      sql`${t.status} <> 'active' or ${t.credentialsCiphertext} is not null`,
    ),
  ],
);
