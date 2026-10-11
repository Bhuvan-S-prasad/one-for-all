# Connect Slack

Slack's MCP server (`https://mcp.slack.com/mcp`) only works with an app you create in your Slack workspace, signed in with your own Slack account. You create it from our manifest and paste its ID and secret into the Connections page. Allow about 10 minutes.

Checked against Slack's documentation on 2026-10-08: [Slack MCP server](https://docs.slack.dev/ai/mcp-server/), [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/).

## Before you start

- **The app stays internal.** Slack lets only *internal* apps (created in your workspace, not distributed) or apps published in its directory use the MCP server; an app shared with other workspaces without being listed is refused. Don't turn on public distribution.
- **Admin approval.** Workspace admins can approve or block MCP clients. On a workspace you don't administer, your admin may have to approve the app.
- **An https address.** Slack wants redirect addresses that start with `https://`. It may accept `http://localhost` for apps that use PKCE, as One-for-All does; if it refuses yours, reach One-for-All over https (for example with Tailscale's HTTPS certificates) and set `APP_URL` to that address. Your redirect address is shown under **Connections → Slack → Set up**: your `APP_URL` followed by `/api/connections/callback`.

## 1. Create the app from the manifest

1. Open [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From a manifest**, and pick your workspace.
2. Paste [`slack-app-manifest.json`](slack-app-manifest.json) and replace `https://YOUR-ADDRESS/api/connections/callback` with your redirect address.
3. **Create.**

The manifest asks only for *user* scopes: agents act as you, in the channels you can see, never as a bot. They cover reading channels, direct messages and group messages, searching public messages, looking up people, and posting (`chat:write`).

## 2. Get the client ID and secret

**Basic Information → App Credentials:** copy the **Client ID** and **Client Secret**. Keep the secret out of chats and files; it goes only into One-for-All, which stores it encrypted.

## 3. Add it to One-for-All

1. **Connections → Slack → Set up**. Paste the client ID and secret, then **Add Slack**.
2. **Connect.** Slack shows what One-for-All may do as you; **Allow**. You return to Connections, signed in.
3. Give an agent Slack on its **Tools** step (Apps → Slack). Reading runs by itself; posting asks you first.

## If something goes wrong

| What you see | What to do |
|---|---|
| `redirect_uri did not match` or "invalid redirect" | The redirect URL in the app (OAuth & Permissions → Redirect URLs) must match the address on the Connections page exactly. If Slack won't accept an `http://` address, use https (see above). |
| "This app is not allowed to use MCP" | The app was distributed: keep it internal to your workspace. |
| "Waiting for admin approval" | Ask a workspace admin to approve the app under *Manage apps*. |

Chatting with agents *from* Slack (a bot in Socket Mode) is a separate channel that comes in M6; it will add bot settings to this manifest.
