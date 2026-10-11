# ADR-0031: Gmail through Google's own API, with a direct Google sign-in

- **Status:** Accepted
- **Date:** 2026-10-08
- **Area:** Integrations
- **Related:** ADR-0011 (MCP-first), ADR-0018 (catalog), ADR-0029 (tools beside an MCP server, partly superseded), ADR-0030 (edit before approving), ARCHITECTURE.md §9.2, §9.4

## Context

Google's Gmail MCP server is in the Google Workspace Developer Preview Program, which takes Google Workspace accounts only. Most people self-hosting One-for-All use a personal `@gmail.com` account, so for them the server never answers, and M4's done-when ("connect Notion and Gmail") can't be met. §9.4's fallback order allows hand-written tools for an app without a usable official server.

The MCP client's sign-in already does what Google needs: PKCE, state, the issuer check, a pinned sign-in site, a client secret, refresh and the vault. It only learns where to sign in from the MCP server; given the sign-in site itself, it reads the site's own OAuth or OpenID metadata, which Google publishes.

## Decision

**Gmail is a catalog app without an MCP server: sign-in goes straight to Google, and its tools are ours, on the Gmail API.**

- **Catalog entries have a kind.** `mcp` (the default) is a remote MCP server at `url`. `api` has none: `url` is the app's API, sign-in starts at `authOrigin` (`https://accounts.google.com`), and no `resource` is named. Everything else is shared: the `mcp_server` and `connection` rows, the sealed tokens, background refresh, `fetchAs` limited to `apiOrigins`, grants and policy. An API app's kept tool list names our tools, so the Connections page and the agent's Tools step show them like any other app's.
- **Five tools** (`packages/mcp/src/extras/gmail.ts`):
  - `gmail.search_messages` and `gmail.read_message` read mail, as outside content (HTML as text).
  - `gmail.create_draft` saves a draft.
  - `gmail.send_email` sends a message.
  - `gmail.send_draft` sends a saved draft, as before.

  Granted as `gmail.*`, reading runs by itself and the three writing tools ask first. Drafting and sending show a draft card whose subject and message can be changed (ADR-0030). Replies stay in the thread (`In-Reply-To`, `References`, `threadId`).
- **We build plain-text email** (`extras/mime.ts`), which ADR-0029 avoided. The rules:
  - Header values can't hold a line break.
  - Recipients must be addresses, at most 20, optionally with a name.
  - Non-ASCII text is RFC 2047-encoded.
  - Reply IDs must be well-formed.
  - The body is base64.

  Bad recipients are refused by the tool's schema, so the call goes back to the model before policy or a person sees it.
- **Same scopes as before** (`gmail.readonly`, `gmail.compose`); compose covers drafts and sending. No preview program and no MCP API to enable, so a personal Google account works with your own OAuth client in *External* mode, published to production.
- `gmail.send_email` has no `verify`: Gmail can't be asked whether a particular message went out, so after a crash mid-send the executor says it can't tell, rather than risk sending twice.

## Alternatives considered

- **Require a Workspace account:** excludes most self-hosters, and the preview program can change or close.
- **A separate Google sign-in module (OAuth by hand):** duplicates PKCE, state, refresh and the vault plumbing that already works and is tested.
- **A community Gmail MCP server:** runs code we haven't reviewed, with the person's mail (ADR-0018).
- **Send only drafts (no `send_email`):** two approvals for one email; the draft card already shows exactly what goes out.

## Consequences

- **Positive:** Gmail works for any Google account. One approval sends an email, from a card that shows it and lets the person fix the wording.
- **Negative:** we maintain Gmail API code and an email builder, and keep up with Gmail API changes. Google Calendar and Drive still go through Google's MCP servers and so still need a Workspace account in the preview program.
- **Follow-up:** Calendar and Drive can become `api` apps the same way if people need them on personal accounts. When Google's Gmail MCP server opens to everyone, the entry can go back to `mcp`, keeping `gmail.send_email` beside it (ADR-0029).
