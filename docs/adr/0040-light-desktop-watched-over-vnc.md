# ADR-0040: A light desktop per agent, watched over VNC

- **Status:** Accepted
- **Date:** 2026-10-10
- **Area:** Computer
- **Related:** Supersedes ADR-0026; amends ADR-0025 (what the image holds); ADR-0010 (one profile per agent), ADR-0012 (takeover), ADR-0017 (perimeter), ADR-0041, ADR-0042, ARCHITECTURE.md §4, §10.5, §14.1

## Context

ADR-0026 streamed only the agent's browser page over CDP, because nothing else was on its screen. People then asked to see the agent work: its terminal, its files, the documents it makes, not just a web page. A first look at the computer panel showed a white page (an empty `about:blank` tab) while the agent's real work (shell commands, files) was invisible.

Each agent already has its own virtual screen (Xvfb, ADR-0025), run as its own Linux user. What it lacks is anything on that screen besides Chromium, and a way to stream the whole screen.

Two desktops were weighed on the sandbox's Debian base:

| | XFCE | Light (Openbox, tint2, PCManFM, xterm, Mousepad) |
|---|---|---|
| Looks like a full desktop | Out of the box | Close: wallpaper, desktop icons, a dock; plainer |
| RAM per open desktop | roughly 150–250 MB | roughly 30–60 MB |
| Three agents at once in the 1.5 GB sandbox | Over the limit with browsers | Fits |
| First-run dialogs, notifications, power and screensaver managers | Several to switch off | None |

Hosted sandboxes with a desktop (Daytona, E2B Desktop) use the same parts (Xvfb, a desktop, x11vnc, noVNC) but cost money and are not self-hosted; they stay out of scope (an E2B adapter remains M7 work).

## Decision

**Each agent's screen gets a light desktop, and people watch and take over the whole screen over VNC.**

- **The desktop** (Debian packages, built for x64 and arm64): Openbox as the window manager, a tint2 dock (Terminal, Files, Browser, Editor, open windows, clock), PCManFM drawing the desktop and its icons and browsing files, xterm with tmux as the terminal, Mousepad as the editor, AbiWord and Gnumeric to open Word and Excel files (ADR-0042). Dark, in the app's colours. No XFCE: the RAM does not fit three agents on the 3 GB target.
- **Per agent, as that agent:** the desktop runs on the agent's own display under its own uid, with its own session bus (needed by the accessibility tree, ADR-0041) in a private runtime folder in its home. Chromium becomes an ordinary maximised window on it.
- **Same lifecycle as the browser was:** the desktop starts when the agent's computer is first needed (a browser tool, a desktop tool, or a person opening the panel), closes after 10 idle minutes, and at most three are open; the least recently used closes first. Closing the browser window does not close the desktop; the next browser tool reopens it.
- **Watching** (DT.04): an x11vnc server on an agent's display only while someone watches, listening on 127.0.0.1 inside the sandbox, bridged by the sandbox service behind its token. The app serves it at `/api/agents/:id/desktop`, a WebSocket behind the same login and Origin checks as the other sockets. The web app draws it with noVNC.
- **Takeover stays as in ADR-0026:** one person at a time; watchers are view-only and only the person in control sends input; meanwhile the agent's computer tools are refused; start and end are audited. Nothing seen or typed is recorded.
- **No animated cursor:** actions happen at full speed. The view shows windows opening, the terminal running and files appearing; it does not slow the agent down to look human.
- **The interface:** `SandboxHandle.desktop(agentId)` joins `screen()` and `takeover()`. The CDP page stream stays as a fallback (no desktop, or a narrow phone view) and can go once nothing uses it.

## Alternatives considered

- **Keep the CDP page stream only (ADR-0026):** the terminal, files and documents stay invisible, which is what people asked to see.
- **XFCE:** the look people pointed at, but about four times the RAM per desktop and several dialogs to suppress; three agents would not fit in the sandbox's 1.5 GB.
- **A hosted desktop sandbox (Daytona, E2B Desktop):** paid, needs an account and a public service, and Daytona's open-source repository was archived in June 2026.
- **A hand-written RFB client instead of noVNC:** less to vet, much more to write and get right (encodings, scaling, input).
- **An animated cursor and typing:** looks human, but slows every task and the free model quota buys nothing for it.

## Consequences

- **Positive:** people see everything the agent's computer shows, native dialogs included; the same screen hosts desktop apps for ADR-0041; watching costs an x11vnc process only while someone watches.
- **Negative:** the image grows by about 300 MB on disk (desktop parts about 171 MB, AbiWord and Gnumeric about 128 MB, measured on Debian bookworm), each open desktop costs some RAM, and noVNC is a new web dependency to keep current. Chromium's own interface (tabs, menus) is now visible and clickable by a person in control, which is intended.
- **Follow-up:** DT.02 the desktop in the image; DT.04 and DT.05 the live view; DT.06 the terminal showing the agent's commands; the phone's computer screen (M6.03) shows the same view.
