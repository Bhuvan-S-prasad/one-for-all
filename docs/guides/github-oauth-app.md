# Connect GitHub

GitHub's MCP server (`https://api.githubcopilot.com/mcp/`) doesn't let apps register themselves, so you create a GitHub OAuth app once and paste it into the Connections page. Allow about 5 minutes.

Checked against GitHub's documentation on 2026-10-08: [Setting up the GitHub MCP server](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server).

## Before you start

- **Your redirect address.** Open **Connections** in One-for-All, choose **Set up** on GitHub, and copy the address shown. It is your `APP_URL` followed by `/api/connections/callback`; while developing, `http://localhost:3000/api/connections/callback`.
- **Organisations:** if your repositories belong to an organisation with OAuth app access restrictions, an owner must approve the app after you create it (step 3). Organisations on Copilot Business or Enterprise must also allow *MCP servers in Copilot* in their policies.

## 1. Create the OAuth app

1. On GitHub: your picture → **Settings → Developer settings → OAuth Apps → New OAuth App** ([direct link](https://github.com/settings/applications/new)).
2. Fill in:
   - **Application name:** `One-for-All`
   - **Homepage URL:** your `APP_URL`, e.g. `http://localhost:3000`
   - **Authorization callback URL:** your redirect address, exactly
   - Leave **Enable Device Flow** off.
3. **Register application.**

## 2. Get the client ID and secret

On the app's page, copy the **Client ID**, then **Generate a new client secret** and copy it right away (GitHub shows it once). Keep it out of chats and files; it goes only into One-for-All, which stores it encrypted.

## 3. Add it to One-for-All

1. **Connections → GitHub → Set up**. Paste the client ID and secret, then **Add GitHub**.
2. **Connect.** GitHub asks you to authorise One-for-All for repositories, organisations (read), your profile (read) and notifications. Organisations with access restrictions show a **Request** button there; an owner then approves it under the organisation's *Third-party access* settings.
3. Give an agent GitHub on its **Tools** step (Apps → GitHub). Reading runs by itself; anything that changes a repository, issue or pull request asks you first.

## If something goes wrong

| What you see | What to do |
|---|---|
| "The redirect_uri is not associated with this application" | The callback URL in step 1 must match the address on the Connections page. |
| An organisation's repositories are missing | The organisation hasn't approved the app yet (step 3). |
| Some tools say you lack access | GitHub's MCP tools follow your account's own access: Copilot features need a Copilot plan, private repositories need your permission. |
