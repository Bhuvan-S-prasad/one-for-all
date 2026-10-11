# ADR-0011: MCP-first integrations

- **Status:** Accepted
- **Date:** 2026-09-30
- **Area:** Integrations
- **Related:** ADR-0012, ADR-0013, ADR-0018, ARCHITECTURE.md §9

## Context

Users expect agents to work with email, calendar, chat, docs, CRM and more. Writing and maintaining every tool for every app is not feasible. By 2026 many vendors host official remote MCP servers with OAuth 2.1 (Notion, Linear, GitHub, Atlassian, Slack, Google Workspace, HubSpot, Stripe and others). The MCP authorization spec (2025-11-25) standardizes discovery and client registration, and the AI SDK's MCP client accepts an `authProvider`.

## Decision

- One generic MCP client in `packages/mcp` with a database-backed OAuth `authProvider`.
- Apps are catalog entries (`packages/mcp/catalog/*.json`); tools are discovered with `tools/list`.
- Grant defaults come from MCP annotations (`readOnlyHint` → auto, `destructiveHint` → approve).
- Built-in capabilities are hand-written once in `packages/tools`.
- Fallback order for other apps: community MCP server, OpenAPI-generated tools, a few hand-written tools, then the agent's browser.

## Alternatives considered

- **Hand-writing every integration:** unbounded work and maintenance.
- **Composio:** fast to start, but tokens live with a third party, it creates lock-in, and overage pricing rose about 13 to 16 times in August 2026.
- **Nango (self-hosted):** handles OAuth well, but MCP's own auth makes it unnecessary for MCP apps. Revisit for APIs with no MCP server.

## Consequences

- **Positive:** vendors write and maintain the tools; adding an app is configuration; new vendor tools appear without a deploy.
- **Negative:** Google needs the self-hoster's own OAuth client (refresh tokens expire after 7 days while the app is in Testing status); Slack needs a manifest-created app and possibly admin approval; Gmail's restricted scopes still apply; large servers expose many tools, so grants must keep lists small.
- **Follow-up:** setup guides (`docs/guides/google-oauth-client.md`, `docs/guides/slack-app-manifest.md`); a `load_toolkit` meta-tool.
