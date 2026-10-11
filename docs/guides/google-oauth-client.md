# Connect Gmail (and Google Calendar and Drive)

Google won't let One-for-All register itself, so you create a Google OAuth client once and paste it into the Connections page. One client serves Gmail, Calendar and Drive. Allow about 15 minutes.

- **Gmail works with any Google account**, including a personal `@gmail.com` one. One-for-All uses the Gmail API directly (ADR-0031).
- **Google Calendar and Google Drive** still go through Google's MCP servers, which need a Google Workspace account in Google's preview program. See [Calendar and Drive](#calendar-and-drive) at the end.

Checked against Google's documentation on 2026-10-08.

## Before you start

**Your redirect address.** Open **Connections** in One-for-All, choose **Set up** on Gmail, and copy the address shown there. It is your `APP_URL` followed by `/api/connections/callback`; while developing, `http://localhost:3000/api/connections/callback`.

## 1. Create a Google Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/) with the Google account whose mail the agents will use.
2. Project picker → **New project**. Name it `One-for-All`, then select it.

## 2. Turn on the Gmail API

**APIs & Services → Library** → search **Gmail API** → **Enable**.

Or with `gcloud`: `gcloud services enable gmail.googleapis.com --project=PROJECT_ID`

## 3. Set up the consent screen

In **Google Auth Platform** (APIs & Services → OAuth consent screen), choose **Get started** if asked:

1. **Branding:** app name `One-for-All`, your email as the support and contact email.
2. **Audience:**
   - With a personal account, choose **External**. Under **Test users**, add your own address.
   - Then choose **Publish app** to move it from *Testing* to *In production*. In *Testing*, Google ends the sign-in after 7 days and agents lose access.
   - The app stays unverified, which is fine for your own use: Google shows a warning when you sign in, and allows up to 100 people.
   - With a Workspace account you can choose **Internal** instead, and skip test users and publishing.
3. **Data access → Add or remove scopes → Manually add scopes**, one per line:

   ```
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.compose
   ```

   *readonly* lets agents search and read; *compose* lets them write drafts and send, which always waits for your approval first.

## 4. Create the OAuth client

1. **Google Auth Platform → Clients → Create client**.
2. **Application type:** *Web application*. Name: `One-for-All`.
3. **Authorized redirect URIs → Add URI:** paste your redirect address exactly, with no trailing slash. Google accepts `http://localhost`; any other address must be `https://`.
4. **Create**, then copy the **Client ID** and **Client secret**. Keep the secret out of chats and files; it goes only into One-for-All, which stores it encrypted.

## 5. Add it to One-for-All

1. **Connections → Gmail → Set up**. Paste the client ID and secret, then **Add Gmail**.
2. **Connect.** Google's sign-in opens; pick your account.
   - Google says *"Google hasn't verified this app"*. Choose **Advanced → Go to One-for-All (unsafe)**: it is your own app.
   - Tick both permissions and continue. You return to Connections, signed in, with Gmail's 5 tools listed.
3. Give an agent Gmail on its **Tools** step (Apps → Gmail):
   - **Reads run, changes ask:** searching and reading run by themselves. Saving a draft or sending shows you the email first, and you can change the subject and message before approving.

## If something goes wrong

| What you see | What to do |
|---|---|
| `redirect_uri_mismatch` | The redirect URI in step 4 must match the address on the Connections page exactly: scheme, host, port and path. |
| `access_denied` or "app not available" | Add your address under **Test users**, or publish the app (step 3). |
| "Access blocked: this app's request is invalid" | The scopes in step 3 are missing, or the client isn't a *Web application*. |
| "Sign in again" after about a week | The app is still in *Testing*: publish it (step 3), then sign in again. |
| A tool says Gmail refused with 403 | The Gmail API isn't enabled (step 2), or you didn't tick a permission at sign-in: **Disconnect** and connect again. |

## Calendar and Drive

Google Calendar and Google Drive use Google's own MCP servers, which are in the [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview). The program takes Google Workspace accounts only, so a personal `@gmail.com` account can't use them yet. With a Workspace account:

1. Apply to the preview program with that account and your Cloud project (Google says a couple of days).
2. Enable each product's API **and** its MCP API ([Google's guide](https://developers.google.com/workspace/guides/configure-mcp-servers)):

   | App | API | MCP API |
   |---|---|---|
   | Google Calendar | `calendar-json.googleapis.com` | `calendarmcp.googleapis.com` |
   | Google Drive | `drive.googleapis.com` | `drivemcp.googleapis.com` |

3. Add the scopes `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/drive` on the consent screen.
4. On the Connections page, set up Google Calendar and Google Drive with the **same** client ID and secret, then connect.

If they sign in but their tools fail with "permission denied" or "service disabled", the MCP API isn't enabled or the preview program hasn't confirmed you yet.
