Every tool call passes through the policy engine before it runs. The engine is code, not a prompt: a model that has been talked into something by a web page still cannot get past it.

## The verdicts

| Verdict   | Meaning                                                           |
| --------- | ----------------------------------------------------------------- |
| `auto`    | Runs without asking                                               |
| `approve` | Waits for a person to approve, edit or deny                       |
| `human`   | Needs a person: an explicit approval, or taking over the computer |
| `deny`    | Refused                                                           |

## How a verdict is reached

Every source gives a verdict and **the strictest wins**. Nothing later can loosen an earlier result.

```flow
Not granted to this agent | deny
On the always-human list | human: payments, deletions, permission or password changes, sharing outside
Destructive by its own annotation | approve
!Outbound in a tainted run | approve, also for an address nobody gave the run; skipped on a site you allowed for this task
An ask-first rule | approve: workspace rules, then personal rules
An allow rule | auto, only if nothing above fired
Otherwise the grant | as you set it: run or ask first
```

A tool is on the always-human list when it declares so, or when its action's words name one (`delete_page`, `create_refund`, `share_file`, `update_permissions`), unless it is read-only. App tools from MCP servers don't say which are payments or deletions, so the words decide.

## Taint

The dangerous combination is private data, outside input and a way to send data out. The engine tracks it per run:

```flow
A run starts clean | your own request, your own data
It reads outside content | a web page, an email, a document, an app's output: the run is tainted until it ends
!It tries something outbound | send, post, click, type, run a command, open a new address: approval required
```

- Taint crosses handoffs both ways: a handoff from a tainted run starts tainted, and a teammate's tainted answer taints the agent that asked.
- A chat record that quotes outside content taints the run that reads it.
- Facts learned in a tainted run are stored unverified.
- A task scheduled after outside content starts tainted.

## Address provenance

In a tainted run, opening an address counts as outbound unless the run was given it. `browser.open`, `web.read_url` and any tool that opens an address run freely only for addresses from the conversation or from the run's own tool results. An address the agent built itself (a page can ask for `evil.example/?email=…`) waits for a person. Addresses in a chat record written by a tainted run don't count as given.

## Proactive checks

A routine of kind _check_ runs read-only: the engine denies anything not annotated read-only, and anything that would end in `approve` or `human`, because nobody is watching a background check to answer.

## Coordinators

Hiding a coordinator's covered tools is a listing rule on top of policy, not a replacement for it. Every handoff still passes grant, policy and taint, and a hidden tool called anyway is refused.

## Schemas first

Before policy, every call is checked against its tool's schema. A malformed call goes back to the model to fix and never reaches policy, the tool-call record or the server.
