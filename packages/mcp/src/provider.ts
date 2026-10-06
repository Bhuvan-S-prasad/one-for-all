import { randomBytes } from "node:crypto";
import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "@ai-sdk/mcp";
import {
  McpError,
  type ConnectionRecord,
  type ConnectionStore,
  type McpServerRecord,
  type RecordCipher,
  type TenantContext,
} from "@ofa/core";

// The MCP client's OAuth state, kept in Postgres and sealed by the vault
// (ADR-0011, ADR-0012). What a workspace registers once (the OAuth client and
// where its sign-in lives) belongs to the server; what each person gets when
// signing in (tokens, or the PKCE verifier on the way) belongs to their
// connection. Every write goes straight to the database, so a sign-in that
// starts in one request finishes in another.

/** The server's sealed value: its OAuth client registration and sign-in site. */
interface ServerSecrets {
  readonly client?: OAuthClientInformation;
  /** Registered by us through dynamic client registration, so it can be replaced. */
  readonly dynamic?: boolean;
  readonly authorizationServer?: OAuthAuthorizationServerInformation;
}

/** A connection's sealed value. */
interface Credentials {
  readonly tokens?: OAuthTokens;
  readonly codeVerifier?: string;
}

export interface AuthProviderOptions {
  readonly ctx: TenantContext;
  readonly server: McpServerRecord;
  readonly store: ConnectionStore;
  readonly cipher: RecordCipher;
  /** Where the provider sends the person back: the API's OAuth callback. */
  readonly redirectUrl: string;
  readonly clientName: string;
  readonly now?: () => number;
}

export interface DbAuthProvider extends OAuthClientProvider {
  /** Set when the flow wants the person to sign in at this address. */
  readonly authorizationUrl: URL | undefined;
  /** The person's connection as it is now. */
  readonly connection: ConnectionRecord | null;
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}

export async function createDbAuthProvider(options: AuthProviderOptions): Promise<DbAuthProvider> {
  const { ctx, store, cipher } = options;
  const now = options.now ?? Date.now;
  const server = options.server;
  const serverScope = { table: "mcp_server" as const, id: server.id };

  let secrets: ServerSecrets = server.client
    ? parse<ServerSecrets>(cipher.open(ctx, serverScope, server.client))
    : {};
  let connection = await store.getConnection(ctx, server.id);
  let credentials: Credentials = connection?.credentials
    ? parse<Credentials>(
        cipher.open(ctx, { table: "connection", id: connection.id }, connection.credentials),
      )
    : {};
  let authorizationUrl: URL | undefined;

  async function saveSecrets(next: ServerSecrets): Promise<void> {
    secrets = next;
    const empty = !next.client && !next.authorizationServer;
    await store.saveServerClient(
      ctx,
      server.id,
      empty ? null : cipher.seal(ctx, serverScope, JSON.stringify(next)),
    );
  }

  /** Seal the credentials into the person's connection, with any other changes. */
  async function saveCredentials(
    next: Credentials,
    patch: Parameters<ConnectionStore["saveConnection"]>[2] = {},
  ): Promise<void> {
    credentials = next;
    // The ciphertext is bound to the row, so the row must exist first.
    connection ??= await store.saveConnection(ctx, server.id, {});
    const empty = !next.tokens && !next.codeVerifier;
    connection = await store.saveConnection(ctx, server.id, {
      ...patch,
      credentials: empty
        ? null
        : cipher.seal(ctx, { table: "connection", id: connection.id }, JSON.stringify(next)),
    });
  }

  return {
    get authorizationUrl() {
      return authorizationUrl;
    },
    get connection() {
      return connection;
    },
    get redirectUrl() {
      return options.redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [options.redirectUrl],
        client_name: options.clientName,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // A self-hosted app can't keep a secret from its own host: a public client, with PKCE.
        token_endpoint_auth_method: "none",
      };
    },

    clientInformation: () => secrets.client,
    isClientInformationDynamicallyRegistered: () => secrets.dynamic === true,
    saveClientInformation: (client) => saveSecrets({ ...secrets, client, dynamic: true }),
    authorizationServerInformation: () => secrets.authorizationServer,
    saveAuthorizationServerInformation: (authorizationServer) =>
      saveSecrets({ ...secrets, authorizationServer }),

    /**
     * Sign-in must happen where the server was set up to send it: pinned by
     * the catalog, or at the first sign-in for a custom server (ADR-0018). A
     * server that later points elsewhere is refused before anything is sent.
     */
    async validateAuthorizationServerURL(_serverUrl, authorizationServerUrl) {
      const origin = new URL(authorizationServerUrl).origin;
      const pinned = server.authOrigin ?? (await store.pinAuthOrigin(ctx, server.id, origin));
      if (pinned !== origin) {
        throw new McpError(
          "auth_origin_mismatch",
          `${server.name} sent sign-in to ${origin}, but it was set up to sign in at ${pinned}. Nothing was sent there; an admin should check this server.`,
        );
      }
    },

    tokens: () => credentials.tokens,
    async saveTokens(tokens) {
      const refreshed = connection?.status === "active";
      await saveCredentials(
        { tokens },
        {
          status: "active",
          oauthState: null,
          lastError: null,
          scopes: tokens.scope ? tokens.scope.split(" ").filter(Boolean) : [],
          expiresAt: tokens.expires_in ? new Date(now() + tokens.expires_in * 1000) : null,
          ...(refreshed ? { refreshedAt: new Date(now()) } : {}),
        },
      );
    },

    state: () => randomBytes(24).toString("base64url"),
    async saveState(state) {
      connection = await store.saveConnection(ctx, server.id, { oauthState: state });
    },
    storedState: () => connection?.oauthState ?? undefined,

    saveCodeVerifier: (codeVerifier) => saveCredentials({ ...credentials, codeVerifier }),
    codeVerifier() {
      if (!credentials.codeVerifier) {
        throw new McpError("sign_in_unknown", "This sign-in wasn't started here; start it again.");
      }
      return credentials.codeVerifier;
    },

    redirectToAuthorization(url) {
      authorizationUrl = url;
    },

    async invalidateCredentials(scope) {
      if (scope === "all" || scope === "client") {
        await saveSecrets(
          scope === "all" ? {} : { authorizationServer: secrets.authorizationServer },
        );
      }
      if (scope === "all" || scope === "tokens") {
        const wasActive = connection?.status === "active";
        await saveCredentials(
          { codeVerifier: credentials.codeVerifier },
          wasActive
            ? { status: "needs_reauth", lastError: "The sign-in expired. Sign in again." }
            : {},
        );
      }
      if (scope === "verifier") await saveCredentials({ tokens: credentials.tokens });
    },
  };
}
