import type {
  ConnectionPatch,
  ConnectionRecord,
  ConnectionStatus,
  ConnectionStore,
  McpAuthKind,
  McpServerRecord,
  McpToolInfo,
  SealedValue,
  TenantContext,
} from "@ofa/core";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../client";
import { connection, mcpServer } from "../schema/index";
import { withTenant, type Tx } from "../tenant";

// MCP servers and people's connections to them (ARCHITECTURE.md §9). Rows hold
// ciphertext only; the vault seals and opens it, and only the MCP client asks.

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

function sealed(
  valueCiphertext: string | null,
  keyCiphertext: string | null,
  keyId: string | null,
): SealedValue | null {
  return valueCiphertext && keyCiphertext && keyId
    ? { valueCiphertext, keyCiphertext, keyId }
    : null;
}

type ServerRow = typeof mcpServer.$inferSelect;
type ConnectionRow = typeof connection.$inferSelect;

function toServer(row: ServerRow): McpServerRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    catalogId: row.catalogId,
    url: row.url,
    auth: row.auth as McpAuthKind,
    authOrigin: row.authOrigin,
    client: sealed(row.clientCiphertext, row.clientKeyCiphertext, row.clientKeyId),
    enabled: row.enabled,
    tools: (row.tools as McpToolInfo[] | null) ?? null,
    toolsFetchedAt: row.toolsFetchedAt,
    createdAt: row.createdAt,
  };
}

function toConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    mcpServerId: row.mcpServerId,
    userId: row.userId,
    status: row.status as ConnectionStatus,
    account: row.account,
    scopes: row.scopes,
    credentials: sealed(row.credentialsCiphertext, row.keyCiphertext, row.keyId),
    oauthState: row.oauthState,
    expiresAt: row.expiresAt,
    refreshedAt: row.refreshedAt,
    lastUsedAt: row.lastUsedAt,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function patchColumns(patch: ConnectionPatch): Partial<typeof connection.$inferInsert> {
  const out: Partial<typeof connection.$inferInsert> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.account !== undefined) out.account = patch.account;
  if (patch.scopes !== undefined) out.scopes = [...patch.scopes];
  if (patch.credentials !== undefined) {
    out.credentialsCiphertext = patch.credentials?.valueCiphertext ?? null;
    out.keyCiphertext = patch.credentials?.keyCiphertext ?? null;
    out.keyId = patch.credentials?.keyId ?? null;
  }
  if (patch.oauthState !== undefined) out.oauthState = patch.oauthState;
  if (patch.expiresAt !== undefined) out.expiresAt = patch.expiresAt;
  if (patch.refreshedAt !== undefined) out.refreshedAt = patch.refreshedAt;
  if (patch.lastUsedAt !== undefined) out.lastUsedAt = patch.lastUsedAt;
  if (patch.lastError !== undefined) out.lastError = patch.lastError;
  return out;
}

const mine = (ctx: TenantContext) => eq(connection.userId, ctx.userId);

async function connectionOf(
  tx: Tx,
  ctx: TenantContext,
  serverId: string,
): Promise<ConnectionRecord | null> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.mcpServerId, serverId), mine(ctx)))
    .limit(1);
  return row ? toConnection(row) : null;
}

export function createConnectionStore(db: Database): ConnectionStore {
  return {
    async getServer(ctx, id) {
      if (!isUuid(id)) return null;
      const [row] = await withTenant(db, ctx, (tx) =>
        tx.select().from(mcpServer).where(eq(mcpServer.id, id)).limit(1),
      );
      return row ? toServer(row) : null;
    },

    async listServers(ctx) {
      const rows = await withTenant(db, ctx, (tx) =>
        tx.select().from(mcpServer).orderBy(asc(mcpServer.name)),
      );
      return rows.map(toServer);
    },

    async createServer(ctx, input) {
      const [row] = await withTenant(db, ctx, (tx) =>
        tx
          .insert(mcpServer)
          .values({
            workspaceId: ctx.workspaceId,
            slug: input.slug,
            name: input.name,
            url: input.url,
            catalogId: input.catalogId ?? null,
            auth: input.auth ?? "oauth",
            authOrigin: input.authOrigin ?? null,
            createdBy: ctx.userId,
          })
          .onConflictDoNothing()
          .returning(),
      );
      return row ? toServer(row) : null;
    },

    async deleteServer(ctx, id) {
      if (!isUuid(id)) return false;
      const rows = await withTenant(db, ctx, (tx) =>
        tx.delete(mcpServer).where(eq(mcpServer.id, id)).returning({ id: mcpServer.id }),
      );
      return rows.length > 0;
    },

    async saveServerClient(ctx, id, client) {
      await withTenant(db, ctx, (tx) =>
        tx
          .update(mcpServer)
          .set({
            clientCiphertext: client?.valueCiphertext ?? null,
            clientKeyCiphertext: client?.keyCiphertext ?? null,
            clientKeyId: client?.keyId ?? null,
          })
          .where(eq(mcpServer.id, id)),
      );
    },

    async saveServerTools(ctx, id, tools) {
      await withTenant(db, ctx, (tx) =>
        tx
          .update(mcpServer)
          .set({ tools: [...tools], toolsFetchedAt: new Date() })
          .where(eq(mcpServer.id, id)),
      );
    },

    async pinAuthOrigin(ctx, id, origin) {
      return withTenant(db, ctx, async (tx) => {
        await tx
          .update(mcpServer)
          .set({ authOrigin: origin })
          .where(and(eq(mcpServer.id, id), isNull(mcpServer.authOrigin)));
        const [row] = await tx
          .select({ authOrigin: mcpServer.authOrigin })
          .from(mcpServer)
          .where(eq(mcpServer.id, id));
        return row?.authOrigin ?? origin;
      });
    },

    async getConnection(ctx, serverId) {
      if (!isUuid(serverId)) return null;
      return withTenant(db, ctx, (tx) => connectionOf(tx, ctx, serverId));
    },

    async findConnectionByState(ctx, state) {
      const [row] = await withTenant(db, ctx, (tx) =>
        tx
          .select()
          .from(connection)
          .where(and(eq(connection.oauthState, state), mine(ctx)))
          .limit(1),
      );
      return row ? toConnection(row) : null;
    },

    async listConnections(ctx) {
      const rows = await withTenant(db, ctx, (tx) => tx.select().from(connection).where(mine(ctx)));
      return rows.map(toConnection);
    },

    async saveConnection(ctx, serverId, patch) {
      return withTenant(db, ctx, async (tx) => {
        const columns = patchColumns(patch);
        const [row] = await tx
          .insert(connection)
          .values({
            workspaceId: ctx.workspaceId,
            mcpServerId: serverId,
            userId: ctx.userId,
            ...columns,
          })
          .onConflictDoUpdate({
            target: [connection.mcpServerId, connection.userId],
            // An empty patch still needs something to set.
            set: { ...columns, updatedAt: sql`now()` },
          })
          .returning();
        if (!row) throw new Error("connection upsert returned no row");
        return toConnection(row);
      });
    },

    async deleteConnection(ctx, serverId) {
      if (!isUuid(serverId)) return false;
      const rows = await withTenant(db, ctx, (tx) =>
        tx
          .delete(connection)
          .where(and(eq(connection.mcpServerId, serverId), mine(ctx)))
          .returning({ id: connection.id }),
      );
      return rows.length > 0;
    },
  };
}
