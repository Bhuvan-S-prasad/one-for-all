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
// needs `Authorization: Bearer <SANDBOX_TOKEN>` (or `?token=` for WebSockets):
//
//   GET  /health                       {ok, version}
//   POST /exec    {agent, command, cwd?, timeoutMs?}
//   POST /files/read  {agent, path}    {content: base64, size}
//   POST /files/write {agent, path, content: base64}
//   POST /files/list  {agent, path}
//   POST /browser {agent}              start the agent's desktop and browser; {path} of its CDP endpoint
//   POST /restart {agent?}             stop an agent's processes (or every agent's)
//   POST /takeover {agent, on}         a person has the agent's browser (M3.07): the
//                                      agent's own requests for it are refused meanwhile
//   GET  /cdp/<agent>/devtools/...     WebSocket proxy to that agent's browser
//
// No dependencies: Node built-ins only. The token never reaches agent
// processes; their environment is built from scratch.

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
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
  return { agentId, slot, uid, home, display: `:${100 + slot}`, cdpPort: 9300 + slot };
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

/** agentId → { user, xvfb, session, chrome, wsPath, timer, usedAt } */
const desktops = new Map();
const starting = new Map();
const browserStarting = new Map();

function touch(entry) {
  entry.usedAt = Date.now();
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => stopDesktop(entry.user.agentId, "idle"), IDLE_MS);
  entry.timer.unref();
}

async function cdpVersion(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
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
  const entry = { user, xvfb, session: [], chrome: null, wsPath: null, timer: undefined };
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
      'for i in $(seq 40); do [ -S "$1/bus" ] && exit 0; sleep 0.1; done; exit 1',
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
    `--remote-debugging-port=${user.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
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
  const chrome = spawnAs(user, ["chromium", ...flags], { stdio: "ignore" });
  entry.chrome = chrome;
  entry.wsPath = null;
  chrome.on("exit", () => {
    if (entry.chrome !== chrome) return;
    entry.chrome = null;
    entry.wsPath = null;
  });

  // Up to about 30 s: a busy host (or a Raspberry Pi) can take 20 s to start it.
  for (let i = 0; i < 120; i += 1) {
    try {
      const info = await cdpVersion(user.cdpPort);
      entry.wsPath = new URL(info.webSocketDebuggerUrl).pathname;
      touch(entry);
      log("browser started", { agent: user.agentId, slot: user.slot });
      return entry;
    } catch {
      if (chrome.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  killGroup(chrome.pid);
  throw httpError(503, "The browser did not start");
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
  if (entry.chrome && entry.chrome.exitCode === null && entry.wsPath) return entry;
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
  for (const child of entry.session) killGroup(child.pid);
  killGroup(entry.xvfb.pid);
  log("desktop stopped", { agent: agentId, reason });
}

/** Stop everything an agent's user is running. */
async function stopAgent(agentId) {
  stopDesktop(agentId, "restart");
  await loadState();
  const slot = slots.get(agentId);
  if (slot === undefined) return;
  await new Promise((resolve) => {
    const kill = spawn("pkill", ["-KILL", "-u", String(UID_BASE + slot)], { stdio: "ignore" });
    kill.on("close", resolve);
    kill.on("error", resolve);
  });
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function authorized(req, url) {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ")
    ? header.slice(7)
    : (url.searchParams.get("token") ?? "");
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

const routes = {
  async "POST /exec"(body) {
    const user = await agentUser(body.agent);
    const command = textArg(body.command, "command");
    const cwd = body.cwd === undefined ? WORKSPACE : textArg(body.cwd, "cwd", 4096);
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT, 1_000),
      MAX_TIMEOUT,
    );
    await ensureVenv(user);
    // `cd` happens as the agent, so it can only enter what the agent may.
    const result = await runAs(user, 'cd -- "$1" && umask 007 && eval "$2"', [cwd, command], {
      timeoutMs,
    });
    return result;
  },

  async "POST /files/read"(body) {
    const user = await agentUser(body.agent);
    const path = textArg(body.path, "path", 4096);
    const result = await runAs(user, 'cd -- "$1" && cat -- "$2"', [WORKSPACE, path], {
      binary: true,
    });
    if (result.exitCode !== 0)
      throw httpError(404, result.stderr.trim() || "Could not read the file");
    if (result.truncated) throw httpError(413, "The file is larger than 10 MB");
    return { content: result.stdout.toString("base64"), size: result.stdout.length };
  },

  async "POST /files/write"(body) {
    const user = await agentUser(body.agent);
    const path = textArg(body.path, "path", 4096);
    if (typeof body.content !== "string") throw httpError(400, "content must be base64");
    const content = Buffer.from(body.content, "base64");
    if (content.length > MAX_FILE) throw httpError(413, "The file is larger than 10 MB");
    const result = await runAs(
      user,
      'cd -- "$1" && umask 007 && mkdir -p -- "$(dirname -- "$2")" && cat > "$2"',
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
      'cd -- "$1" && find "$2" -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%T@\\t%f\\n" | head -n 1001',
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
    if (takenOver.has(body.agent) && body.person !== true) {
      throw httpError(423, "A person is using this browser right now");
    }
    const entry = await browserFor(body.agent);
    return { path: `/cdp/${entry.user.agentId}${entry.wsPath}` };
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

// CDP over WebSocket: /cdp/<agent>/devtools/... is piped to that agent's
// browser, which listens on 127.0.0.1 only. Host and Origin are rewritten,
// since Chromium accepts DevTools connections only from local pages.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://sandbox");
  const match = /^\/cdp\/([A-Za-z0-9-]{1,64})(\/devtools\/.+)$/.exec(url.pathname);
  const entry = match ? desktops.get(match[1]) : undefined;
  if (!authorized(req, url) || !entry?.chrome || entry.chrome.exitCode !== null) {
    socket.end(`HTTP/1.1 ${authorized(req, url) ? "404 Not Found" : "401 Unauthorized"}\r\n\r\n`);
    return;
  }
  touch(entry);
  const upstream = net.connect(entry.user.cdpPort, "127.0.0.1", () => {
    const headers = Object.entries(req.headers)
      .filter(([name]) => !["host", "origin", "authorization"].includes(name))
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    upstream.write(
      [
        `GET ${match[2]} HTTP/1.1`,
        `host: 127.0.0.1:${entry.user.cdpPort}`,
        ...headers,
        "",
        "",
      ].join("\r\n"),
    );
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  // An open connection (someone watching, a long tool call) keeps the browser in use.
  const keepAlive = setInterval(() => touch(entry), 60_000);
  const close = () => {
    clearInterval(keepAlive);
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  upstream.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
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
