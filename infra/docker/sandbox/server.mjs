// The sandbox service (M3.01, M3.03, M3.04): runs inside the agents'
// computer and does what the app asks, as the agent that asked.
//
// Every agent gets its own Linux user (uid 10001 and up), home directory
// (mode 700) and Chromium profile, so one agent cannot read another's files
// or use its logins (ADR-0010). All agents also belong to the `agents` group,
// which owns the shared /workspace. Processes are started with setpriv; this
// service is the only thing that runs as root, and Compose leaves it only the
// CHOWN, SETUID, SETGID and KILL capabilities.
//
// HTTP on SANDBOX_PORT (internal network only), every route but /health
// needs `Authorization: Bearer <SANDBOX_TOKEN>` (or `?token=` for the /cdp
// WebSocket, which can't set a header). A request with an `Origin` header comes
// from a web page, never from the app, and is refused:
//
//   GET  /health                       {ok, version}
//   POST /exec    {agent, command, cwd?, timeoutMs?}
//   POST /files/read  {agent, path}    {content: base64, size}
//   POST /files/write {agent, path, content: base64}
//   POST /files/list  {agent, path}
//   POST /browser {agent}              start the agent's desktop and browser; {path} of its CDP endpoint
//   POST /open {agent, path}           open a file or folder in its app on the desktop
//   POST /apps {agent, request}        its desktop apps through their accessibility tree
//   POST /restart {agent?}             stop an agent's processes (or every agent's)
//   POST /takeover {agent, on}         a person has the agent's computer (M3.07, ADR-0040):
//                                      the agent's browser, commands and file writes are
//                                      refused meanwhile
//   GET  /cdp/<agent>                  WebSocket to that agent's browser (DevTools,
//                                      relayed over the browser's pipe: no port)
//   GET  /desktop/<agent>[?control=1]  upgrade to the raw VNC stream of the agent's
//                                      desktop (ADR-0040); control needs a takeover
//
// No dependencies: Node built-ins only. The token never reaches agent
// processes; their environment is built from scratch.

import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, chown, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";

const VERSION = "1";
const PORT = Number(process.env.SANDBOX_PORT ?? 7070);
const TOKEN = process.env.SANDBOX_TOKEN ?? "";
/** The egress proxy (M3.02); the sandbox network has no other way out. */
const PROXY = process.env.SANDBOX_PROXY ?? "";
/** An agent's desktop and browser close after this long unused (ADR-0040). */
const IDLE_MS = Number(process.env.SANDBOX_BROWSER_IDLE_MS ?? 10 * 60_000);
/**
 * Desktops open at once, each with its browser (~200 MB and ~130 threads for
 * Chromium, a little more for the desktop); past the limit the least recently
 * used one closes (its home and profile, and so its logins, stay).
 */
const MAX_DESKTOPS = Number(process.env.SANDBOX_MAX_BROWSERS ?? 3);

const HOMES = "/home/agents";
const STATE_DIR = `${HOMES}/.state`;
const STATE_FILE = `${STATE_DIR}/agents.json`;
const WORKSPACE = "/workspace";
const AGENTS_GID = 10000;
const UID_BASE = 10001;
const MAX_AGENTS = 500;
const MAX_OUTPUT = 256 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_BODY = 15 * 1024 * 1024;
const DEFAULT_TIMEOUT = 60_000;
const MAX_TIMEOUT = 10 * 60_000;
const SCREEN = "1280x800x24";

if (TOKEN.length < 16) {
  console.error("SANDBOX_TOKEN must be set to at least 16 characters");
  process.exit(1);
}

const log = (msg, fields = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));

// ── Agents and their users ─────────────────────────────────────────────────

/** Agent IDs are the app's UUIDs; anything else is refused before it nears a path. */
const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/;

let slots = new Map();
let stateLoaded = false;
let stateLock = Promise.resolve();

async function loadState() {
  if (stateLoaded) return;
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATE_DIR, 0o700);
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    slots = new Map(Object.entries(saved.agents ?? {}));
  } catch {
    slots = new Map();
  }
  stateLoaded = true;
}

/** The agent's slot, allocated on first use and kept across restarts. */
function slotFor(agentId) {
  const next = stateLock.then(async () => {
    await loadState();
    const known = slots.get(agentId);
    if (known !== undefined) return known;
    const used = new Set(slots.values());
    let slot = 0;
    while (used.has(slot)) slot += 1;
    if (slot >= MAX_AGENTS) throw httpError(507, "This computer has room for no more agents");
    slots.set(agentId, slot);
    const tmp = `${STATE_FILE}.${randomUUID()}`;
    await writeFile(tmp, JSON.stringify({ agents: Object.fromEntries(slots) }), { mode: 0o600 });
    await rename(tmp, STATE_FILE);
    return slot;
  });
  stateLock = next.catch(() => {});
  return next;
}

async function agentUser(agentId) {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) {
    throw httpError(400, "agent must be an agent ID");
  }
  const slot = await slotFor(agentId);
  const uid = UID_BASE + slot;
  const home = `${HOMES}/${uid}`;
  await mkdir(home, { recursive: true, mode: 0o700 });
  // Mode first, then hand it over: without CAP_FOWNER this service cannot
  // change a directory it no longer owns.
  if ((await stat(home)).uid !== uid) {
    await chmod(home, 0o700);
    await chown(home, uid, uid);
  }
  return { agentId, slot, uid, home, display: `:${100 + slot}` };
}

/** A clean environment for agent processes: never the service's own (it holds the token). */
function agentEnv(user, extra = {}) {
  const run = `${user.home}/.run`;
  const env = {
    HOME: user.home,
    USER: `agent${user.slot}`,
    LOGNAME: `agent${user.slot}`,
    // The agent's own venv first (ADR-0042): `pip install` lands in its home.
    PATH: `${user.home}/.venv/bin:/usr/local/bin:/usr/bin:/bin`,
    VIRTUAL_ENV: `${user.home}/.venv`,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    TERM: "dumb",
    DISPLAY: user.display,
    // The display's key: its socket sits in the shared /tmp, so without it
    // any agent could watch or type into another's screen.
    XAUTHORITY: `${user.home}/.Xauthority`,
    // The desktop's session bus (ADR-0040), private to the agent: apps it
    // starts appear on its desktop and publish their accessibility tree.
    XDG_RUNTIME_DIR: run,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${run}/bus`,
    GTK_THEME: "Adwaita:dark",
    GTK2_RC_FILES: "/etc/gtk-2.0/one-for-all.gtkrc",
    // GTK2 apps (PCManFM) publish their accessibility tree only when asked (DT.09).
    GTK_MODULES: "gail:atk-bridge",
    ...extra,
  };
  if (PROXY) {
    for (const name of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"])
      env[name] = PROXY;
    env.no_proxy = env.NO_PROXY = "localhost,127.0.0.1";
  }
  return env;
}

/**
 * Start `argv` as the agent: its own uid and group, plus the shared `agents`
 * group. Files are made group-writable but not world-readable (umask 007):
 * shared in /workspace (setgid `agents`), private elsewhere.
 */
function spawnAs(user, argv, options = {}) {
  return spawn(
    "setpriv",
    [
      `--reuid=${user.uid}`,
      `--regid=${user.uid}`,
      `--groups=${AGENTS_GID}`,
      "--no-new-privs",
      "--",
      ...argv,
    ],
    { env: agentEnv(user, options.env), stdio: options.stdio ?? "pipe", detached: true },
  );
}

/** Run a shell command as the agent, with a time limit and capped output. */
function runAs(user, script, args, { input, timeoutMs = DEFAULT_TIMEOUT, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnAs(user, ["bash", "-c", script, "bash", ...args]);
    const out = { stdout: [], stderr: [], size: { stdout: 0, stderr: 0 } };
    let truncated = false;
    let timedOut = false;
    const collect = (stream) => (chunk) => {
      const room = (binary && stream === "stdout" ? MAX_FILE : MAX_OUTPUT) - out.size[stream];
      if (room <= 0) return void (truncated = true);
      if (chunk.length > room) truncated = true;
      const part = chunk.subarray(0, Math.max(0, room));
      out[stream].push(part);
      out.size[stream] += part.length;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out.stdout);
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        stdout: binary ? stdout : stdout.toString("utf8"),
        stderr: Buffer.concat(out.stderr).toString("utf8"),
        truncated,
        timedOut,
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

// ── Python ──────────────────────────────────────────────────────────────────

/** agentId → its venv check, once per start of this service. */
const venvs = new Map();

/**
 * The agent's own venv (ADR-0042), first on its PATH: made on first use, with
 * the system's packages (openpyxl, python-docx) visible, and remade if it no
 * longer runs (a newer image with a newer Python). Packages installed into it
 * stay in the agent's home.
 */
function ensureVenv(user) {
  if (!venvs.has(user.agentId)) {
    const check = runAs(
      user,
      '"$1/bin/python" -c "" 2>/dev/null || python3 -m venv --clear --system-site-packages "$1"',
      [`${user.home}/.venv`],
      { timeoutMs: 120_000 },
    ).then((result) => {
      if (result.exitCode === 0) return;
      venvs.delete(user.agentId);
      log("venv failed", { agent: user.agentId, error: result.stderr.slice(0, 500) });
    });
    venvs.set(user.agentId, check);
  }
  return venvs.get(user.agentId);
}

// ── Desktops and browsers ───────────────────────────────────────────────────
//
// Each agent's computer is a light desktop on its own display (ADR-0040):
// Xvfb, a private session bus, openbox, the pcmanfm desktop and the tint2
// dock, all running as the agent. Its Chromium is an ordinary window there;
// closing it leaves the desktop, and the next browser tool reopens it.

/** Agents whose computer a person has taken over (M3.07). In memory: a restart hands it back. */
const takenOver = new Set();

/** agentId → { user, xvfb, session, viewers, chrome, relay, timer, usedAt } */
const desktops = new Map();
const starting = new Map();
const browserStarting = new Map();

function touch(entry) {
  entry.usedAt = Date.now();
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => stopDesktop(entry.user.agentId, "idle"), IDLE_MS);
  entry.timer.unref();
}

async function startDesktop(user) {
  // Xvfb keeps its lock and socket in the shared /tmp.
  await mkdir("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
  await chmod("/tmp/.X11-unix", 0o1777);
  const n = user.display.slice(1);
  await rm(`/tmp/.X${n}-lock`, { force: true });
  await rm(`/tmp/.X11-unix/X${n}`, { force: true });
  // A fresh key for the display, readable by the agent alone.
  const auth = `${user.home}/.Xauthority`;
  const key = await runAs(
    user,
    'umask 077 && rm -f -- "$1" && xauth -q -f "$1" add "$2" . "$(mcookie)"',
    [auth, user.display],
  );
  if (key.exitCode !== 0) throw httpError(503, "The computer's screen did not start");
  const xvfb = spawnAs(
    user,
    ["Xvfb", user.display, "-screen", "0", SCREEN, "-nolisten", "tcp", "-auth", auth],
    { stdio: "ignore" },
  );
  const entry = {
    user,
    xvfb,
    session: [],
    viewers: new Set(),
    chrome: null,
    relay: null,
    timer: undefined,
  };
  xvfb.on("exit", () => {
    if (desktops.get(user.agentId) === entry) stopDesktop(user.agentId, "display closed");
  });

  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready && xvfb.exitCode === null; i += 1) {
      ready = await stat(`/tmp/.X11-unix/X${n}`).then(
        () => true,
        () => new Promise((r) => setTimeout(() => r(false), 125)),
      );
    }
    if (!ready) throw httpError(503, "The computer's screen did not start");

    // The session bus lives in a private folder in the agent's home (this
    // service cannot look inside it, so the agent waits for its own socket).
    const run = `${user.home}/.run`;
    const start = (argv) => entry.session.push(spawnAs(user, argv, { stdio: "ignore" }));
    await runAs(user, 'mkdir -p -m 700 -- "$1" && chmod 700 -- "$1" && rm -f -- "$1/bus"', [run]);
    start([
      "dbus-daemon",
      "--session",
      "--nofork",
      "--nopidfile",
      `--address=unix:path=${run}/bus`,
    ]);
    const bus = await runAs(
      user,
      '[ -p "$1/pause" ] || mkfifo -- "$1/pause"; for i in $(seq 40); do [ -S "$1/bus" ] && exit 0; read -rt 0.1 _ <>"$1/pause"; done; exit 1',
      [run],
    );
    if (bus.exitCode !== 0) throw httpError(503, "The computer's desktop did not start");

    // Desktop icons: the shared workspace beside the agent's own files. The
    // desktop reads its look from the agent's own config only, so it is
    // copied in at every start.
    await runAs(
      user,
      [
        'mkdir -p -- "$HOME/Desktop" && ln -sfn /workspace "$HOME/Desktop/Workspace"',
        'conf="$HOME/.config/pcmanfm/one-for-all" && mkdir -p -- "$conf"',
        'cp -f /etc/xdg/pcmanfm/one-for-all/desktop-items-0.conf "$conf/"',
        '[ -e "$conf/pcmanfm.conf" ] || cp /etc/xdg/pcmanfm/one-for-all/pcmanfm.conf "$conf/"',
      ].join(" && "),
      [],
    );
    // The terminal on the desktop finds the agent's venv too.
    await ensureVenv(user);
    start(["openbox", "--sm-disable"]);
    start(["pcmanfm", "--desktop", "--profile", "one-for-all"]);
    start(["tint2", "-c", "/etc/xdg/tint2/one-for-all.tint2rc"]);
    // Ready once the desktop is drawn (up to 3 s), so a first viewer doesn't
    // start from a black screen.
    await runAs(
      user,
      'p="$HOME/.run/pause"; [ -p "$p" ] || mkfifo -- "$p"; for i in $(seq 30); do xdotool search --onlyvisible --class pcmanfm >/dev/null 2>&1 && break; read -rt 0.1 _ <>"$p"; done',
      [],
    );
  } catch (error) {
    for (const child of entry.session) killGroup(child.pid);
    killGroup(xvfb.pid);
    throw error;
  }

  desktops.set(user.agentId, entry);
  touch(entry);
  log("desktop started", { agent: user.agentId, slot: user.slot });
  return entry;
}

// ── DevTools over a pipe ────────────────────────────────────────────────────
//
// Chromium speaks DevTools on its fds 3 (in) and 4 (out) with
// --remote-debugging-pipe, so it opens no port: agents share the network,
// and a port on 127.0.0.1 let any agent drive another's browser and read its
// cookies (DT.14). This service is the browser's only client. It accepts the
// app's WebSocket connections itself and relays their commands, giving each
// command a number of its own and routing replies and page events back to the
// connection that asked; a connection's page sessions are detached when it
// closes.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest message a client may send (commands are small; this is generous). */
const MAX_WS_MESSAGE = 16 * 1024 * 1024;

/** A minimal WebSocket server end over an upgraded socket: text messages, ping, close. */
function acceptWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let onMessage = () => {};
  let onClose = () => {};
  let closed = false;

  const frame = (opcode, payload) => {
    const length = payload.length;
    const header =
      length < 126
        ? Buffer.from([0x80 | opcode, length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
          : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(length)]);
    if (!closed && !socket.destroyed) socket.write(Buffer.concat([header, payload]));
  };
  const end = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    onClose();
  };
  const parse = () => {
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_WS_MESSAGE) return end();
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= buffer[maskAt + (i & 3)];
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        frame(0x8, Buffer.alloc(0));
        return end();
      }
      if (opcode === 0x9) frame(0xa, payload);
      else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          onMessage(message);
        }
      }
    }
  };
  socket.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    parse();
  });
  socket.on("close", end);
  socket.on("error", end);
  if (buffer.length) queueMicrotask(parse);
  return {
    onMessage: (handler) => void (onMessage = handler),
    onClose: (handler) => void (onClose = handler),
    send: (text) => frame(0x1, Buffer.from(text, "utf8")),
    close: end,
  };
}

function bigLength(length) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  return bytes;
}

/** The relay between one Chromium's pipe and the app's DevTools connections. */
function cdpRelay(chrome) {
  const toChrome = chrome.stdio[3];
  const fromChrome = chrome.stdio[4];
  let nextId = 1;
  /** relay id → { client, id, method } or { resolve } for the relay's own calls. */
  const pending = new Map();
  /** page session → the connection that attached it. */
  const owners = new Map();
  const clients = new Set();
  let partial = [];

  const write = (message) => toChrome.write(`${JSON.stringify(message)}\0`);
  const deliver = (message) => {
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (waiting.resolve) return waiting.resolve(message);
      if (!clients.has(waiting.client)) return;
      if (waiting.method === "Target.attachToTarget" && message.result?.sessionId) {
        owners.set(message.result.sessionId, waiting.client);
      }
      return waiting.client.send(JSON.stringify({ ...message, id: waiting.id }));
    }
    // A page's own events go to the connection that attached to the page.
    if (message.sessionId) return owners.get(message.sessionId)?.send(JSON.stringify(message));
    if (message.method === "Target.detachedFromTarget") {
      const owner = owners.get(message.params?.sessionId);
      owners.delete(message.params?.sessionId);
      return owner?.send(JSON.stringify(message));
    }
    // Browser-wide events (targets coming and going) go to everyone.
    const text = JSON.stringify(message);
    for (const client of clients) client.send(text);
  };
  fromChrome.on("data", (chunk) => {
    let start = 0;
    for (let at = chunk.indexOf(0); at !== -1; at = chunk.indexOf(0, start)) {
      partial.push(chunk.subarray(start, at));
      const text = Buffer.concat(partial).toString("utf8");
      partial = [];
      start = at + 1;
      try {
        deliver(JSON.parse(text));
      } catch {
        // Not JSON: nothing to route.
      }
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  });
  toChrome.on("error", () => {});
  fromChrome.on("error", () => {});

  return {
    /** A command of the relay's own, e.g. to see that the browser answers. */
    call(method, params = {}) {
      return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, { resolve });
        write({ id, method, params });
      });
    },
    attach(client) {
      clients.add(client);
      client.onMessage((text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof message?.id !== "number" || typeof message.method !== "string") return;
        const id = nextId++;
        pending.set(id, { client, id: message.id, method: message.method });
        write({ ...message, id });
      });
      client.onClose(() => {
        clients.delete(client);
        for (const [sessionId, owner] of owners) {
          if (owner !== client) continue;
          owners.delete(sessionId);
          write({ id: nextId++, method: "Target.detachFromTarget", params: { sessionId } });
        }
      });
    },
    /** The browser went away: close every connection. */
    close() {
      for (const client of [...clients]) client.close();
      clients.clear();
      pending.clear();
      owners.clear();
    },
  };
}

async function startBrowser(entry) {
  const { user } = entry;
  // A crash leaves the profile locked, and the dock's Browser may have
  // started Chromium without DevTools: replace it with one the tools can use.
  const profile = `${user.home}/chromium`;
  await runAs(
    user,
    'pkill -KILL -u "$(id -u)" -x chromium; mkdir -p -- "$1" && rm -f -- "$1"/Singleton*',
    [profile],
  );
  const flags = [
    `--user-data-dir=${profile}`,
    // DevTools on fds 3 and 4, never a port (above).
    "--remote-debugging-pipe",
    // The container is the boundary; Chromium's own sandbox needs privileges
    // this container does not have.
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction",
    // No GPU in a container: skip the GPU process and its memory.
    "--disable-gpu",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--renderer-process-limit=4",
    "--password-store=basic",
    // The desktop closes the browser by stopping it: no "Restore pages?".
    // And no bar warning about --no-sandbox to people watching (above).
    "--hide-crash-restore-bubble",
    "--test-type",
    "--start-maximized",
    "--window-position=0,0",
    `--window-size=${SCREEN.split("x").slice(0, 2).join(",")}`,
    ...(PROXY ? [`--proxy-server=${PROXY}`, "--proxy-bypass-list=<-loopback>"] : []),
    "about:blank",
  ];
  const chrome = spawnAs(user, ["chromium", ...flags], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  const relay = cdpRelay(chrome);
  entry.chrome = chrome;
  entry.relay = null;
  chrome.on("exit", () => {
    relay.close();
    if (entry.chrome !== chrome) return;
    entry.chrome = null;
    entry.relay = null;
  });

  // Up to about 30 s: a busy host (or a Raspberry Pi) can take 20 s to start it.
  const answered = await Promise.race([
    relay.call("Browser.getVersion").then((reply) => !reply.error),
    new Promise((resolve) => chrome.once("exit", () => resolve(false))),
    new Promise((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  if (!answered || chrome.exitCode !== null) {
    killGroup(chrome.pid);
    throw httpError(503, "The browser did not start");
  }
  entry.relay = relay;
  touch(entry);
  log("browser started", { agent: user.agentId, slot: user.slot });
  return entry;
}

/** The agent's desktop, started if needed. */
async function desktopFor(agentId) {
  const user = await agentUser(agentId);
  const running = desktops.get(agentId);
  if (running) {
    touch(running);
    return running;
  }
  if (!starting.has(agentId)) {
    // Make room: close the least recently used desktops beyond the limit.
    const open = [...desktops.values()].sort((a, b) => a.usedAt - b.usedAt);
    while (open.length >= MAX_DESKTOPS) stopDesktop(open.shift().user.agentId, "making room");
    starting.set(
      agentId,
      startDesktop(user).finally(() => starting.delete(agentId)),
    );
  }
  return starting.get(agentId);
}

/** The agent's desktop with its browser running. */
async function browserFor(agentId) {
  const entry = await desktopFor(agentId);
  if (entry.chrome && entry.chrome.exitCode === null && entry.relay) return entry;
  if (!browserStarting.has(agentId)) {
    browserStarting.set(
      agentId,
      startBrowser(entry).finally(() => browserStarting.delete(agentId)),
    );
  }
  return browserStarting.get(agentId);
}

function stopDesktop(agentId, reason) {
  const entry = desktops.get(agentId);
  if (!entry) return;
  desktops.delete(agentId);
  clearTimeout(entry.timer);
  if (entry.chrome) killGroup(entry.chrome.pid);
  for (const child of [...entry.viewers, ...entry.session]) killGroup(child.pid);
  killGroup(entry.xvfb.pid);
  log("desktop stopped", { agent: agentId, reason });
}

// ── Watching the desktop ────────────────────────────────────────────────────
//
// A person's view of an agent's desktop (ADR-0040): one x11vnc per viewer,
// run as the agent, listening on a socket in /run/ofa-vnc/<uid>, which only
// that agent and this service can enter. Never a TCP port: agents share the
// network, so any of them could reach it. View-only unless the viewer has
// control, which needs the computer taken over.

const VNC_DIR = "/run/ofa-vnc";

async function vncDir(user) {
  const dir = `${VNC_DIR}/${user.uid}`;
  await mkdir(VNC_DIR, { recursive: true, mode: 0o755 });
  await mkdir(dir, { recursive: true });
  if ((await stat(dir)).uid !== user.uid) {
    // Group root and setgid: the sockets the agent makes here stay reachable
    // by this service, and no other agent can enter.
    await chmod(dir, 0o2770);
    await chown(dir, user.uid, 0);
  }
  return dir;
}

/** Start a viewer's x11vnc on the agent's desktop and connect to it. */
async function openViewer(agentId, control) {
  const entry = await desktopFor(agentId);
  const { user } = entry;
  const sock = `${await vncDir(user)}/${randomUUID()}.sock`;
  const args = [
    "-display",
    user.display,
    "-unixsock",
    sock,
    // No TCP at all: both settings are needed, or it listens on [::]:5900.
    "-rfbport",
    "0",
    "-rfbportv6",
    "-1",
    "-noipv6",
    // One viewer, then exit; give up if nobody connects.
    "-once",
    "-timeout",
    "20",
    "-nopw",
    "-quiet",
    "-nossl",
    "-nolookup",
    "-norc",
    "-nocmds",
    "-nobell",
    // A watcher sends no input and gets no clipboard.
    ...(control ? [] : ["-viewonly", "-nosel"]),
  ];
  const vnc = spawnAs(user, ["bash", "-c", 'umask 007 && exec x11vnc "$@"', "x11vnc", ...args], {
    stdio: "ignore",
  });
  entry.viewers.add(vnc);
  vnc.on("exit", () => {
    entry.viewers.delete(vnc);
    void rm(sock, { force: true }).catch(() => {});
  });

  for (let i = 0; i < 40 && vnc.exitCode === null; i += 1) {
    if (
      await stat(sock).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 125));
  }
  const upstream = await new Promise((resolve, reject) => {
    const connection = net.connect(sock);
    connection.once("connect", () => resolve(connection));
    connection.once("error", reject);
  }).catch(() => {
    killGroup(vnc.pid);
    throw httpError(503, "The desktop view did not start");
  });
  return { entry, vnc, upstream };
}

/** `/desktop/<agent>[?control=1]`: the viewer's raw VNC stream, after a 101. */
async function upgradeDesktop(req, socket, head, url) {
  const refuse = (status, message) => {
    const body = JSON.stringify({ error: message });
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  };
  if (!authorized(req, url)) return refuse(401, "Unauthorized");
  const match = /^\/desktop\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
  if (!match) return refuse(404, "Not found");
  const agentId = match[1];
  const control = url.searchParams.get("control") === "1";
  // Input only while the computer is taken over: then the agent's own tools wait.
  if (control && !takenOver.has(agentId)) return refuse(423, "Take over the computer first");

  let viewer;
  try {
    viewer = await openViewer(agentId, control);
  } catch (error) {
    return refuse(
      error.status ?? 503,
      error.status ? error.message : "The desktop view did not start",
    );
  }
  const { entry, vnc, upstream } = viewer;
  if (socket.destroyed) {
    upstream.destroy();
    return killGroup(vnc.pid);
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: rfb\r\n\r\n");
  if (head.length) upstream.write(head);
  upstream.pipe(socket);
  socket.pipe(upstream);
  log("desktop view opened", { agent: agentId, control });
  // Someone watching keeps the desktop in use.
  const keepAlive = setInterval(() => touch(entry), 60_000);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    upstream.destroy();
    socket.destroy();
    killGroup(vnc.pid);
    log("desktop view closed", { agent: agentId, control });
  };
  upstream.on("error", close);
  upstream.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
}

/** Stop everything an agent's user is running. */
/**
 * agentId → how many times its computer was restarted. A command that began
 * before a restart must not start after it (DT.06): each step checks.
 */
const restarts = new Map();
const restartCount = (agentId) => restarts.get(agentId) ?? 0;

/** What a command returns when a restart stopped it before it began. */
const STOPPED_BY_RESTART = {
  exitCode: 128,
  stdout: "",
  stderr: "The computer was restarted before this command ran.\n",
  truncated: false,
  timedOut: false,
};

async function stopAgent(agentId) {
  restarts.set(agentId, restartCount(agentId) + 1);
  stopDesktop(agentId, "restart");
  await loadState();
  const slot = slots.get(agentId);
  if (slot === undefined) return;
  const killAll = () =>
    new Promise((resolve) => {
      const kill = spawn("pkill", ["-KILL", "-u", String(UID_BASE + slot)], { stdio: "ignore" });
      kill.on("close", resolve);
      kill.on("error", resolve);
    });
  await killAll();
  // Again shortly after: a process caught starting (still root, before it
  // takes the agent's uid) escapes a kill by uid the first time.
  await new Promise((r) => setTimeout(r, 300));
  await killAll();
}

// ── Showing the agent's work ────────────────────────────────────────────────
//
// While an agent's desktop is up, its commands run in its own terminal there
// (DT.06): each in a new tab of tmux session "work", shown in an "Agent
// terminal" window brought to the front, apart from the person's terminal
// ("main"). `one-for-all-run` shows the command and its output as it runs and
// saves both streams and the exit code, so the tool gets what an unseen run
// would return: same shell, folder, umask, closed stdin, limits and caps.

/** Tabs kept in the agent's terminal; older ones close. */
const WORK_TABS = 8;

/** A shell snippet that raises the agent's window of this class, if it has one. */
function bringToFront(windowClass) {
  return `xdotool search --onlyvisible --class ${windowClass} 2>/dev/null | tail -n 1 | xargs -r xdotool windowactivate 2>/dev/null; true`;
}

async function execShown(user, command, cwd, timeoutMs, generation) {
  const id = randomUUID().slice(0, 12);
  const dir = `${user.home}/.run/work/${id}`;
  const prepared = await runAs(
    user,
    'umask 077 && mkdir -p -- "$1" && printf %s "$2" >"$1/cwd" && cat >"$1/command"',
    [dir, cwd],
    { input: command },
  );
  if (restartCount(user.agentId) !== generation) return STOPPED_BY_RESTART;
  if (prepared.exitCode !== 0)
    return runAs(user, 'cd -- "$1" && umask 007 && eval "$2"', [cwd, command], { timeoutMs });

  if (restartCount(user.agentId) !== generation) return STOPPED_BY_RESTART;
  // A new tab named after the command; the window opens (or comes forward).
  const name =
    (command.trim().split(/\s+/)[0] ?? "command").replace(/[^\w.-]/g, "").slice(0, 20) || "command";
  const opened = await runAs(
    user,
    [
      "tmux has-session -t work 2>/dev/null || tmux new-session -d -s work -x 110 -y 30",
      // No tab, no run: only then may it run unseen instead (exit 9).
      'tmux new-window -t work: -n "$2" one-for-all-run "$1" || exit 9',
      // Oldest first by window id (tab numbers get reused), never the newest.
      `tmux list-windows -t work -F '#{window_id}' | tr -d @ | sort -n | head -n -${WORK_TABS} | sed 's/^/@/' | xargs -r -n 1 tmux kill-window -t`,
      '[ -n "$(tmux list-clients -t work)" ] || (setsid one-for-all-terminal --agent >/dev/null 2>&1 &)',
      // A pause with bash's own read, so no sleep shows among its processes.
      'mkfifo -- "$1/pause" && read -rt 0.3 _ <>"$1/pause"',
      bringToFront("AgentTerminal"),
    ].join("; "),
    [dir, name],
  );
  if (opened.exitCode === 9) {
    void runAs(user, 'rm -rf -- "$1"', [dir]).catch(() => {});
    if (restartCount(user.agentId) !== generation) return STOPPED_BY_RESTART;
    return runAs(user, 'cd -- "$1" && umask 007 && eval "$2"', [cwd, command], { timeoutMs });
  }

  if (restartCount(user.agentId) !== generation) {
    return { ...STOPPED_BY_RESTART, stderr: "The computer was restarted as this command began.\n" };
  }
  // Wait for it to finish, or for its runner to vanish (the tab closed), or
  // never to start; on the time limit, stop everything it started.
  const waited = await runAs(
    user,
    [
      // Pauses use bash's own read on a private fifo: no sleep processes.
      'i=0; mkfifo -- "$1/tick" 2>/dev/null',
      'while [ ! -e "$1/exit" ]; do',
      '  if [ -e "$1/runner" ]; then kill -0 "$(cat -- "$1/runner")" 2>/dev/null || exit 2',
      // Not started after 5 s: cancel, unless it started just now. The runner
      // records itself before it checks for the mark, and this marks before
      // it checks again, so the command runs once, here or unseen.
      '  elif [ $i -gt 50 ]; then touch "$1/cancel"; [ -e "$1/runner" ] || exit 3; fi',
      '  i=$((i + 1)); read -rt 0.1 _ <>"$1/tick"',
      "done",
    ].join("\n"),
    [dir],
    { timeoutMs },
  );
  if (waited.exitCode === 3) {
    // The tab never ran it: run it unseen instead.
    void runAs(user, 'rm -rf -- "$1"', [dir]).catch(() => {});
    if (restartCount(user.agentId) !== generation) return STOPPED_BY_RESTART;
    return runAs(user, 'cd -- "$1" && umask 007 && eval "$2"', [cwd, command], { timeoutMs });
  }
  if (waited.timedOut || waited.exitCode === 2) {
    await runAs(
      user,
      'kill -KILL -- "-$(cat -- "$1/pid")" 2>/dev/null; [ -p "$1/pause" ] || mkfifo -- "$1/pause"; for i in $(seq 30); do [ -e "$1/exit" ] && break; read -rt 0.1 _ <>"$1/pause"; done',
      [dir],
    );
  }
  const [stdout, stderr, exit] = await Promise.all([
    runAs(user, 'cat -- "$1/stdout" 2>/dev/null', [dir]),
    runAs(user, 'cat -- "$1/stderr" 2>/dev/null', [dir]),
    runAs(user, 'cat -- "$1/exit" 2>/dev/null', [dir]),
  ]);
  void runAs(user, 'rm -rf -- "$1"', [dir]).catch(() => {});
  const code = Number.parseInt(exit.stdout.trim(), 10);
  const cutOff = !waited.timedOut && Number.isNaN(code);
  return {
    exitCode: waited.timedOut ? 128 : cutOff ? 1 : code,
    stdout: stdout.stdout,
    stderr: cutOff
      ? `${stderr.stdout}(Its terminal tab was closed before the command finished.)\n`
      : stderr.stdout,
    truncated: stdout.truncated || stderr.truncated,
    timedOut: waited.timedOut,
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * The app is the only caller. A browser always names the page it comes from
 * (`Origin`), and the app's Node clients never do, so a request with one is a
 * web page trying the port (ADR-0017). The token comes in the header; only a
 * WebSocket upgrade, which can't set one, may carry it as `?token=`.
 */
function authorized(req, url, { upgrade = false } = {}) {
  if (req.headers.origin !== undefined) return false;
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ")
    ? header.slice(7)
    : upgrade
      ? (url.searchParams.get("token") ?? "")
      : "";
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Body must be JSON");
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function textArg(value, name, max = 100_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw httpError(400, `${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Opens $2 (relative to $1) in the app for its type, as the agent, and prints
 * the app's name. Exit 4: no such file; 5: no app here opens it.
 */
const OPEN_SCRIPT = `
p=$2; case "$p" in "~") p=$HOME ;; "~/"*) p="$HOME/\${p:2}" ;; esac
cd -- "$1" || exit 1
[ -e "$p" ] || { echo "There is no $2 on this computer." >&2; exit 4; }
full=$(realpath -- "$p")
name=$(basename -- "$full")
if [ -d "$full" ]; then
  app=pcmanfm; set -- "$full"
else
  case "\${name,,}" in
    *.docx|*.doc|*.odt|*.rtf|*.abw) app=abiword; set -- "$full" ;;
    *.xlsx|*.xls|*.ods|*.csv|*.tsv|*.gnumeric) app=gnumeric; set -- "$full" ;;
    *.png|*.jpg|*.jpeg|*.gif|*.webp|*.bmp) app=feh; set -- --scale-down --auto-zoom --title "$name" "$full" ;;
    *.txt|*.md|*.markdown|*.log|*.json|*.html|*.htm|*.xml|*.yaml|*.yml|*.py|*.js|*.ts|*.sh|*.ini|*.toml) app=mousepad; set -- "$full" ;;
    *)
      # Empty files read as "binary" to file(1): they are new text files.
      if [ -s "$full" ] && [ "$(file -b --mime-encoding -- "$full")" = binary ]; then
        echo "No app on this computer opens $name. Send it to the person with files.send instead." >&2
        exit 5
      fi
      app=mousepad; set -- "$full" ;;
  esac
fi
(setsid "$app" "$@" >/dev/null 2>&1 &)
# Bring its window to the front once it shows (up to 3 s): the person
# watching sees it, and so does the agent's next snapshot.
pattern=$(printf %s "$name" | sed 's/[][\\.*^$+?(){}|/]/\\\\&/g')
pause="$HOME/.run/pause"; [ -p "$pause" ] || mkfifo -- "$pause"
for i in $(seq 30); do
  w=$(xdotool search --onlyvisible --name "$pattern" 2>/dev/null | tail -n 1)
  if [ -n "$w" ]; then xdotool windowactivate "$w" 2>/dev/null; break; fi
  read -rt 0.1 _ <>"$pause"
done
echo "$app"
`;

/**
 * Sets $p to the path in $2, with a leading ~ as the agent's own home, as the
 * shell would read it; relative paths stay relative to the workspace.
 */
const PATH_ARG = 'p=$2; case "$p" in "~") p=$HOME ;; "~/"*) p="$HOME/${p:2}" ;; esac; cd -- "$1"';

/** While a person has the computer (ADR-0040), the agent's own requests wait. */
function refuseIfTakenOver(body) {
  if (takenOver.has(body.agent) && body.person !== true) {
    throw httpError(423, "A person is using this computer right now");
  }
}

const routes = {
  async "POST /exec"(body) {
    refuseIfTakenOver(body);
    const user = await agentUser(body.agent);
    const command = textArg(body.command, "command");
    const cwd = body.cwd === undefined ? WORKSPACE : textArg(body.cwd, "cwd", 4096);
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT, 1_000),
      MAX_TIMEOUT,
    );
    const generation = restartCount(user.agentId);
    await ensureVenv(user);
    if (restartCount(user.agentId) !== generation) return STOPPED_BY_RESTART;
    // While its desktop is up, the agent's command runs where people can see it.
    if (desktops.has(user.agentId)) {
      return execShown(user, command, cwd, timeoutMs, generation);
    }
    // `cd` happens as the agent, so it can only enter what the agent may.
    const result = await runAs(user, 'cd -- "$1" && umask 007 && eval "$2"', [cwd, command], {
      timeoutMs,
    });
    return result;
  },

  async "POST /files/read"(body) {
    const user = await agentUser(body.agent);
    const path = textArg(body.path, "path", 4096);
    const result = await runAs(user, `${PATH_ARG} && cat -- "$p"`, [WORKSPACE, path], {
      binary: true,
    });
    if (result.exitCode !== 0)
      throw httpError(404, result.stderr.trim() || "Could not read the file");
    if (result.truncated) throw httpError(413, "The file is larger than 10 MB");
    return { content: result.stdout.toString("base64"), size: result.stdout.length };
  },

  async "POST /files/write"(body) {
    refuseIfTakenOver(body);
    const user = await agentUser(body.agent);
    const path = textArg(body.path, "path", 4096);
    if (typeof body.content !== "string") throw httpError(400, "content must be base64");
    const content = Buffer.from(body.content, "base64");
    if (content.length > MAX_FILE) throw httpError(413, "The file is larger than 10 MB");
    const result = await runAs(
      user,
      `${PATH_ARG} && umask 007 && mkdir -p -- "$(dirname -- "$p")" && cat > "$p"`,
      [WORKSPACE, path],
      { input: content },
    );
    if (result.exitCode !== 0)
      throw httpError(400, result.stderr.trim() || "Could not write the file");
    return { size: content.length };
  },

  async "POST /files/list"(body) {
    const user = await agentUser(body.agent);
    const path = body.path === undefined ? "." : textArg(body.path, "path", 4096);
    const result = await runAs(
      user,
      `${PATH_ARG} && find "$p" -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%T@\\t%f\\n" | head -n 1001`,
      [WORKSPACE, path],
    );
    if (result.exitCode !== 0)
      throw httpError(404, result.stderr.trim() || "Could not list that folder");
    const lines = result.stdout.split("\n").filter(Boolean);
    const entries = lines.slice(0, 1000).map((line) => {
      const [type, size, modified, ...name] = line.split("\t");
      return {
        name: name.join("\t"),
        type: type === "d" ? "directory" : type === "l" ? "link" : "file",
        size: Number(size),
        modifiedAt: new Date(Number(modified) * 1000).toISOString(),
      };
    });
    return { entries, truncated: lines.length > 1000 };
  },

  async "POST /browser"(body) {
    // While a person has taken over, only the person's own connection gets in.
    refuseIfTakenOver(body);
    const entry = await browserFor(body.agent);
    // The agent's browsing comes to the front, as its commands do (DT.06).
    if (body.person !== true) {
      void runAs(entry.user, bringToFront("chromium"), []).catch(() => {});
    }
    return { path: `/cdp/${entry.user.agentId}` };
  },

  async "POST /open"(body) {
    // A file or folder in its app on the desktop (ADR-0043). Only apps that
    // send nothing anywhere: never the browser, which could fetch what a
    // file points at.
    refuseIfTakenOver(body);
    const user = await agentUser(body.agent);
    const path = textArg(body.path, "path", 4096);
    await desktopFor(user.agentId);
    const result = await runAs(user, OPEN_SCRIPT, [WORKSPACE, path]);
    if (result.exitCode !== 0) {
      throw httpError(
        result.exitCode === 4 ? 404 : 400,
        result.stderr.trim() || "Couldn't open it",
      );
    }
    return { app: result.stdout.trim() };
  },

  async "POST /apps"(body) {
    // The agent's desktop apps through their accessibility tree (DT.09).
    refuseIfTakenOver(body);
    const user = await agentUser(body.agent);
    if (typeof body.request !== "object" || body.request === null) {
      throw httpError(400, "request must be an object");
    }
    await desktopFor(user.agentId);
    // Binary, for the 10 MB cap: a screenshot's reply is larger than a command's.
    const result = await runAs(user, "exec one-for-all-a11y", [], {
      input: JSON.stringify(body.request),
      timeoutMs: 60_000,
      binary: true,
    });
    let reply;
    try {
      reply = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw httpError(
        503,
        result.timedOut ? "The desktop took too long to answer" : "The desktop didn't answer",
      );
    }
    if (result.exitCode === 3) throw httpError(410, reply.error);
    if (result.exitCode !== 0)
      throw httpError(400, reply.error ?? "That didn't work on the desktop");
    return reply;
  },

  async "POST /takeover"(body) {
    await agentUser(body.agent);
    if (body.on === true) takenOver.add(body.agent);
    else takenOver.delete(body.agent);
    log(body.on === true ? "takeover started" : "takeover ended", { agent: body.agent });
    return { on: takenOver.has(body.agent) };
  },

  async "POST /restart"(body) {
    if (body.agent === undefined) {
      await Promise.all([...desktops.keys()].map((id) => stopAgent(id)));
      await loadState();
      await Promise.all([...slots.keys()].map((id) => stopAgent(id)));
    } else {
      await agentUser(body.agent);
      await stopAgent(body.agent);
    }
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://sandbox");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, version: VERSION });
    }
    if (!authorized(req, url)) throw httpError(401, "Unauthorized");
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw httpError(404, "Not found");
    send(res, 200, await route(await readBody(req)));
  } catch (error) {
    const status = error.status ?? 500;
    if (status === 500) log("request failed", { path: url.pathname, error: String(error) });
    send(res, status, { error: status === 500 ? "Internal error" : error.message });
  }
});

// DevTools over WebSocket: /cdp/<agent> joins that agent's browser relay
// (above). The browser itself listens nowhere.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://sandbox");
  if (url.pathname.startsWith("/desktop/")) return void upgradeDesktop(req, socket, head, url);
  const match = /^\/cdp\/([A-Za-z0-9-]{1,64})(\/.*)?$/.exec(url.pathname);
  const entry = match ? desktops.get(match[1]) : undefined;
  const allowed = authorized(req, url, { upgrade: true });
  if (!allowed || !entry?.relay) {
    socket.end(`HTTP/1.1 ${allowed ? "404 Not Found" : "401 Unauthorized"}\r\n\r\n`);
    return;
  }
  const client = acceptWebSocket(req, socket, head);
  if (!client) return;
  touch(entry);
  entry.relay.attach(client);
  // An open connection (someone watching, a long tool call) keeps the browser in use.
  const keepAlive = setInterval(() => touch(entry), 60_000);
  socket.on("close", () => clearInterval(keepAlive));
});

// Volumes come up owned by whoever created them: put the layout right.
await mkdir(HOMES, { recursive: true });
await chown(HOMES, 0, 0);
await chmod(HOMES, 0o755);
await chown(WORKSPACE, 0, AGENTS_GID);
// The setgid bit (new files belong to `agents`, so every agent can share
// them) survives chmod only when the caller is in that group: without
// CAP_FSETID the kernel clears it otherwise. Join the group just for this.
process.setegid(AGENTS_GID);
await chmod(WORKSPACE, 0o2770);
process.setegid(0);
await loadState();

server.listen(PORT, "0.0.0.0", () => log("sandbox ready", { port: PORT, proxy: PROXY || null }));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    for (const id of [...desktops.keys()]) stopDesktop(id, "shutdown");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
