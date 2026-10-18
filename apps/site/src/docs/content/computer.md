Each agent has a computer to work on: a light Linux desktop inside the sandbox, where it is its own user with its own home, browser profile and Python environment.

## What is on it

| Part         | What the agent does with it                                                                                          | Tools                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Browser      | Opens sites, reads them through the accessibility tree, clicks, types, goes back                                     | `browser.open`, `browser.snapshot`, `browser.click`, `browser.type`, `browser.press`, `browser.back` |
| Terminal     | Runs commands and Python, in a tmux session you can see                                                              | `shell.run`                                                                                          |
| Files        | Reads and writes files under `/workspace`, and sends you any file up to 10 MB                                        | `files.read`, `files.write`, `files.list`, `files.send`                                              |
| Desktop apps | Opens files in apps (Mousepad for text, AbiWord for Word files, Gnumeric for spreadsheets), and works their controls | `desktop.open`, `desktop.snapshot`, `desktop.click`, `desktop.type`, `desktop.press`                 |
| Python       | `pip` and a private `~/.venv`, with `openpyxl` and `python-docx` ready for Excel and Word files                      | through `shell.run`                                                                                  |

The desktop is Openbox with a small dock, a file manager and a terminal. It starts with the agent's computer, closes after ten idle minutes, and at most three run at once.

## Reading the screen

Agents work through the **accessibility tree** first: `desktop.snapshot` lists the window in front as numbered controls with their roles and names, and the agent acts on a number. This needs no vision model and costs few tokens. Screenshots and clicks at a point (`desktop.screenshot`, `desktop.click_at`, `desktop.type_text`) are a fallback, listed only when the agent's model can read images. Only the latest screenshot stays in the prompt.

## Watching and taking over

Open the agent's **computer panel** to watch its whole screen live, over VNC. Watchers only watch; one person at a time can **take control** of the mouse and keyboard, and while they do, the agent's computer tools are refused. Nothing you see or type is recorded; the start and end of a takeover are audited. Take over whenever a site needs a password, a 2FA code, a CAPTCHA or a payment.

## Saved logins

Save a site's username and password once, in the vault. The agent signs in with `use_saved_login`, which types them into a page on that site (or its subdomains) only. The model never sees the password, and it is redacted from all output.

## Files reach you

Files the agent writes appear under its reply, and in the agent's **Files** section. `files.send` attaches any file from its computer to the reply. Opening a file on the desktop is not treated as sending: it uses only apps that send nothing anywhere, never the browser.

## Safety of the computer

The sandbox has no Docker socket, no access to your files, a read-only root file system and limits on CPU, memory and processes. Agents never run as root. Its only way out is an egress proxy that allows ports 80 and 443 and never reaches private, loopback or local addresses. See [The computer, inside](/docs/sandbox).
