The design starts from what went wrong for other always-on agents in 2026: tens of thousands of publicly exposed instances, a one-click localhost exploit, and hundreds of malicious skills in an open marketplace.

## Threats and controls

| Threat                          | Comes in through                      | Control                                                               |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Prompt injection                | Emails, pages, documents, app output  | Taint escalation, labelled outside content, read-only checks          |
| An agent with too much power    | Broad grants                          | Per-agent grants, the always-human list                               |
| Stolen credentials              | The vault, logs, the sandbox, prompts | Envelope encryption, decryption only in the executor, redaction       |
| A compromised host              | Code an agent runs                    | Non-root sandbox, no Docker socket, no host mounts, limits            |
| Data carried out                | The sandbox's network                 | An egress allowlist, no private addresses                             |
| An exposed app, CSRF            | The web app and its socket            | 127.0.0.1 only, login always, Origin and CSRF checks                  |
| Supply chain                    | Skills, MCP servers, packages         | A reviewed catalog, pinned sign-in sites, skills as instructions only |
| Poisoned memory                 | Facts from outside content            | Unverified until you confirm                                          |
| Data leaking between workspaces | Queries                               | Row-level security on every table, on in self-host too                |
| Runaway cost                    | Loops, broad routines                 | Budgets, loop detection, routines that pause themselves               |

## Secrets

- **Envelope encryption.** Every secret has its own data key, wrapped by the vault key and bound to its row: named secrets, a connection's tokens and an app's OAuth client alike.
- **Opened only to run a tool.** Values are decrypted only inside the tool executor, never in the harness, the prompt or the sandbox.
- **The vault key** comes from `VAULT_KEY`, or, running from source, from the OS keychain (`pnpm vault keychain:store`).
- **Rotation** re-wraps data keys, not values: the old key stays a previous key until the app has re-wrapped everything at its next start. `pnpm vault status` shows which key wraps how many values.
- **Redaction.** Known secret values become `[REDACTED]` in tool output, run events, approvals, replies, logs and traces.

## The perimeter

- The app binds to `127.0.0.1`. Login is required even locally.
- HTTP and WebSocket requests are checked for Host, Origin and CSRF, so a web page can't drive the app through your browser.
- After the first owner account, sign-up closes.

## Tenancy

Every table carries `workspace_id` and is protected by Postgres row-level security, on in self-host mode too. Every repository function requires a tenant context. Sign-in tables are the one exception, because one person can belong to several workspaces and sign-in happens before a workspace is known; workspace data is reached only through a membership, which is under row-level security.

## Policy

See [Policy and taint](/docs/policy) for how each tool call is decided.
