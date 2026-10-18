Agents reach your apps through the **Model Context Protocol** (MCP): the vendor runs a server that lists its tools, and One-for-All connects to it. Adding an app is a catalog entry, not code.

## Three levels

| Level | Concept        | What happens                                                                                                                                          |
| ----- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| You   | **Connection** | You sign in once per app, on the Connections page. Tokens are encrypted in the vault and refreshed in the background.                                 |
| Agent | **Grant**      | Per agent, you choose which of the app's tools it may use: off, "reads run, changes ask", or "ask every time", and single tools apart from that.      |
| Run   | **Execution**  | The model sees tool names and schemas only. The executor checks policy, adds your token, calls the server, and returns a result with secrets removed. |

## The catalog

A reviewed list of apps, each pinned to the site where you sign in:

| App                           | Setup                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Notion, Linear                | None: the app registers itself the first time you connect                                        |
| GitHub                        | Create a GitHub OAuth app and enter its ID and secret on the Connections page                    |
| Gmail                         | Signs in at Google directly and uses our own tools on the Gmail API, so any Google account works |
| Google Calendar, Google Drive | Your own Google OAuth client; Google's servers for these take Workspace accounts                 |
| Slack                         | A Slack app from our manifest, kept internal to your Slack workspace                             |

The step-by-step guides for GitHub, Google and Slack are in the repository's `docs/guides` folder.

## Gmail

Gmail has five tools: `gmail.search_messages`, `gmail.read_message`, `gmail.create_draft`, `gmail.send_email` and `gmail.send_draft`. Mail is plain text, built under strict header rules. Reading mail taints the run, so a send after reading always waits for you.

## Large apps and small windows

Free models get worse with long tool lists, and one app can bring dozens of tools (Notion's server alone offers 46, about 55,000 tokens of schemas). So an app with more than eight granted tools stays out of the model's list: the agent sees which apps it can load, and calls `load_toolkit` for the one it needs. An app with more than twelve tools loads a few named tools at a time.

## Checked before it runs

Every call is checked against the tool's schema before anything else. An app's JSON Schema is compiled into a validator when the tool is registered, so a malformed call goes back to the model to fix and never reaches policy, the log or the server.

## Safety

- **The sign-in site is pinned.** A server that later sends you to sign in somewhere else is refused before anything is fetched from it.
- **Results are outside content**, so they taint the run.
- **Expired tokens** are refreshed on the next call; every ten minutes a background job refreshes sign-ins about to run out. A refused refresh marks the connection "sign in again", in plain words.
- **Custom servers** need an owner or admin, an explicit acknowledgement and an https address.
