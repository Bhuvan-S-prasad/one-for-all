# Reviewing a catalog entry

The catalog (`packages/mcp/catalog/*.json`) lists the MCP servers people can add with one click. Each entry runs with whatever permissions people grant its tools, so there is no open marketplace: an entry goes in only after this review (ADR-0018). Custom servers stay possible, behind an explicit warning, but they are never added to the catalog without it.

## Before you start

You need the server's published address and its documentation from the vendor's own site. Community, mirror and "awesome list" pages don't count as sources.

## The checklist

1. **The vendor runs the server.** The address is on the vendor's own domain, and the vendor's documentation names it. A server on a third party's domain needs a recorded reason in the pull request.
2. **https only.** The `url` starts with `https://`. The loader refuses anything else. For an `api` entry (no MCP server, ADR-0031), `url` is the app's API and its tools are written and reviewed in `packages/mcp/src/extras/` like any other code.
3. **The sign-in site matches what the server publishes.** Fetch the protected-resource metadata (`<origin>/.well-known/oauth-protected-resource<path>`) and copy the origin of its first `authorization_servers` entry into `authOrigin`, with no path. One-for-All refuses sign-in anywhere else, so a wrong value fails safely, while a careless one could send people to a phishing page.
4. **Setup is right.** Fetch the authorization server's metadata (`<authorization server>/.well-known/oauth-authorization-server<path>`). If it has a `registration_endpoint`, use `"setup": "automatic"`. Otherwise use `"setup": "own_client"`, and write or link a guide in `docs/guides/` explaining how to create the OAuth app and which redirect address to give it.
5. **Ask for little.** Look at the `scopes_supported` the server advertises. If they go beyond what the entry's description promises, list the narrower set in `scopes`. Without `scopes`, sign-in asks for everything the server advertises. Prefer read scopes, plus only the write scopes the description mentions.
6. **The description is honest.** Say what the server can do in one plain sentence, and say what it can't do when people would expect it (for example, Gmail's server writes drafts but can't send).
7. **Look at the tools.** Sign in with a test account and list the tools (`GET /api/mcp-servers/:id/tools`). Check that destructive tools carry `destructiveHint` and read-only ones `readOnlyHint`, because grant defaults come from these hints. Check that payments, deletions, permission changes and sharing would land on the always-human list (ADR-0028). If any wouldn't, note it for M4.05 to set `humanOnly`.
8. **Extra sign-in parameters only when needed.** `authorizationParams` exists for providers that need one to work properly (Google issues refresh tokens only with `access_type=offline`). Say why in the pull request.
9. **Date it.** Set `reviewed` to today. Re-review an entry when the vendor changes its server or sign-in, or within a year.

## After it merges

Existing installs keep the address and sign-in site they were added with. If an entry's `authOrigin` changes, people must remove the app and add it again, deliberately, rather than having sign-in quietly follow a new site.
