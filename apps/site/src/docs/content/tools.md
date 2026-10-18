The built-in tools every agent can be granted, by area. Apps you connect add their own tools, named after the app (`notion.search`). Tools that change nothing outside the run are read-only; the rest count as outbound for [taint](/docs/policy).

## Web and memory

| Tool             | Does                                              | Read-only |
| ---------------- | ------------------------------------------------- | --------- |
| `web.search`     | Searches the web through self-hosted SearXNG      | yes       |
| `web.read_url`   | Reads a page, 6,000 characters at a time          | yes       |
| `remember`       | Saves a fact to memory                            |           |
| `recall`         | Searches memory                                   | yes       |
| `todo.write`     | Writes the agent's plan, with an owner per item   | yes       |
| `artifacts.read` | Reopens a long output by its `artifact://` handle | yes       |

## The computer

| Tool                                                             | Does                                                                  | Read-only |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | --------- |
| `browser.open`                                                   | Opens an address in the agent's own browser                           |           |
| `browser.snapshot`                                               | Reads the page as numbered controls                                   | yes       |
| `browser.click`, `browser.type`, `browser.press`, `browser.back` | Works the page                                                        |           |
| `use_saved_login`                                                | Types a saved username and password into that site                    |           |
| `shell.run`                                                      | Runs a command in the agent's terminal                                |           |
| `files.read`, `files.list`                                       | Reads files under `/workspace`                                        | yes       |
| `files.write`                                                    | Writes a file; it appears under the reply                             |           |
| `files.send`                                                     | Sends any file up to 10 MB with the reply                             |           |
| `desktop.open`                                                   | Opens a file in a desktop app (not outbound: those apps send nothing) |           |
| `desktop.snapshot`                                               | Reads the window in front as numbered controls                        | yes       |
| `desktop.click`, `desktop.type`, `desktop.press`                 | Works a desktop app                                                   |           |
| `desktop.screenshot`, `desktop.click_at`, `desktop.type_text`    | The screenshot fallback, for models that read images                  |           |

## The team

| Tool            | Does                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `delegate_task` | Hands a piece of work to a teammate with a brief, and waits for the answer; `include_results_from` passes earlier answers on by name |
| `message_agent` | Posts a message to another agent, which replies later in the same chat                                                               |

## Later

| Tool            | Does                                           |
| --------------- | ---------------------------------------------- |
| `remind_me`     | Posts a reminder at a time, with no model call |
| `schedule_task` | Wakes the agent later to do a piece of work    |

## Skills and apps

| Tool           | Does                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `run_skill`    | Opens a skill's steps                                                |
| `save_skill`   | Saves a procedure as a skill (held for review after outside content) |
| `load_toolkit` | Loads an app's tools, or a few of them, for the rest of the run      |

## Gmail

| Tool                    | Does                 |
| ----------------------- | -------------------- |
| `gmail.search_messages` | Searches the mailbox |
| `gmail.read_message`    | Reads one message    |
| `gmail.create_draft`    | Saves a draft        |
| `gmail.send_email`      | Sends an email       |
| `gmail.send_draft`      | Sends a saved draft  |

Every call is checked against the tool's schema, then by [policy](/docs/policy), before it runs.
