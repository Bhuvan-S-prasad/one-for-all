The agents' computers run in one container built from our own slim image. Agents share the container but not their homes: each works as its own Linux user.

## The shape of it

```layers
App | the API reaches the sandbox service through a forward on the egress container, with a shared token | never joins the sandbox network
Sandbox service | runs as root with only CHOWN, SETUID, SETGID and KILL; starts each agent's desktop and relays its browser | inside the sandbox
Agents | one Linux user each: a private home, a browser profile, a Python venv, a display | /home/<agent>, /workspace
Egress proxy | the only way out: an allowlist, ports 80 and 443, never private, loopback, link-local or CGNAT addresses | checked after DNS
```

## Isolation

- **No Docker socket and no host mounts**: only the sandbox's own volumes.
- **A read-only root file system**, with limits on CPU, memory and processes.
- **Agent code never runs as root.**
- **No route out** except the egress proxy, which checks each address after DNS and connects to the checked address, so a domain can't be pointed at your router after the check.
- **Nothing listens on the network** for an agent: Chromium is driven over its DevTools pipe, each display has a key only its agent reads, and desktop viewers use a socket in a folder only that agent and the service can enter.
- **Credentials never enter the sandbox.** The only sign-ins in it are browser sessions you created there yourself.

## The desktop

Each agent's display runs Openbox with a tint2 dock, the PCManFM file manager, xterm with tmux, Mousepad, AbiWord and Gnumeric, with its own session bus. It starts when needed, stops after ten idle minutes, and at most three run at once. Three desktops measured at 0.9 to 1.2 GB.

## Watching over VNC

When someone watches, x11vnc starts on 127.0.0.1 inside the sandbox, the sandbox service bridges it, and the API serves it at `/api/agents/:id/desktop` behind login and Origin checks. The web app draws it with noVNC. Watchers are view-only; one person at a time can take control, and meanwhile the agent's computer tools are refused.

## The accessibility tree first

Agents read pages through Chromium's accessibility tree (over CDP) and desktop apps through AT-SPI, as numbered controls. Each number is checked against the control's role and name before acting. Screenshots and clicks at a point are a fallback for models that read images; points are fractions of the screen, which free vision models hit far better than pixels.

## Python and files

`pip`, `venv`, `openpyxl` and `python-docx` are in the image. Each agent has its own `~/.venv` first on its PATH, so packages it installs stay in its home. `pip` goes through the egress proxy. `files.send` attaches any file up to 10 MB to the reply.

## Images

The image is built for x86-64 and arm64, so it runs on a Raspberry Pi and on ARM cloud machines.
