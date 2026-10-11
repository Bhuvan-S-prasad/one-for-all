# ADR-0029: A few hand-written tools beside an MCP server, on its sign-in

- **Status:** Accepted; for Gmail, superseded by [ADR-0031](0031-gmail-through-googles-api.md) (Gmail now has no MCP server, and we build plain-text email)
- **Date:** 2026-10-06
- **Area:** Integrations
- **Related:** ADR-0011 (MCP-first), ADR-0012 (credentials), ADR-0013 (policy), ARCHITECTURE.md §9.2, §9.4

## Context

M4's done-when is "the agent drafts an email and waits for your approval before sending". Google's official Gmail MCP server reads mail and writes drafts (`create_draft`), but it has no tool that sends: Google expects people to send from Gmail. The architecture's fallback order (§9.4) allows "a few hand-written tools" for what an official server doesn't cover.

A hand-written Gmail tool could get its own Google sign-in, but that means a second OAuth flow, a second token store and a second consent screen for the same account. The person has already signed in to Gmail through the MCP server, and that token carries `gmail.compose`, which is the scope Google requires for sending a draft.

## Decision

**Hand-written tools can sit beside an app's MCP server and use its sign-in.**

- A catalog entry lists its app's own API origins (`apiOrigins`). `McpConnections.fetchAs` sends one HTTP request with the person's token, only to those origins and with redirects refused. It refreshes an expired token first, refreshes and retries once on a 401, and marks the connection "sign in again" if the token is still refused. The token stays inside `packages/mcp`; tools get responses.
- These tools join the app's toolkit like its server's own tools. They are named under its slug and go through the same policy, grants and redaction.
- **The first and only one is `gmail.send_draft`.** It sends an existing draft by ID through `POST /gmail/v1/users/me/drafts/send`. It is outbound, so granted as part of `gmail.*` it asks first, and in a run that read outside content taint escalation asks anyway. Its `describe` reads the draft (`drafts.get`, metadata only), so the approval card says what goes out: *Send the email "Quarterly numbers" to sam@example.com*, followed by the start of the body. Sending isn't idempotent, so after a crash `verify` treats a missing draft as sent.
- We send drafts, never compose messages. What the person reviewed is exactly what goes out, and we never build raw email, which would be open to header injection and encoding mistakes.
- No Google client library: one `fetch` does it.

## Alternatives considered

- **A separate Google sign-in for sending:** a second consent and token store for the same account, with no gain.
- **Compose-and-send (`messages.send`):** the approval would show text we built, not the draft the person can open in Gmail, and building MIME is a source of bugs.
- **Have the person send from Gmail:** keeps us out of sending, but M4's done-when (approve, then it sends) becomes a manual step.

## Consequences

- **Positive:** draft, approve, send works with one sign-in, and the card shows the real draft.
- **Negative:** we maintain a little Gmail API code, and Google may issue the MCP sign-in's token for its MCP server only. If the Gmail API refuses it, sign-in must ask Google for a token valid for both. That is checked in the M4 end-to-end test.
- **Follow-up:** M4.09's draft card (edit, send, discard) uses `gmail.send_draft`. Further tools here need a reason the server can't cover, and a review like a catalog entry.
