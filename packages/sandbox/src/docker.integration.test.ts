import { randomUUID } from "node:crypto";
import {
  asId,
  SandboxError,
  type AgentId,
  type DesktopStream,
  type TenantContext,
} from "@ofa/core";
import { beforeAll, describe, expect, it } from "vitest";
import { connectCdp } from "./cdp";
import { createDockerSandbox } from "./docker";

// Against the dev sandbox from `pnpm infra:up` (the sandbox and egress
// services): every agent its own user, the shared workspace, limits, the
// egress rules and a real browser. Skipped when the sandbox isn't running.

const url = process.env.SANDBOX_URL ?? "http://127.0.0.1:7070";
const token = process.env.SANDBOX_TOKEN ?? "ofa-sandbox-dev-token";
const up = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
  .then((r) => r.ok)
  .catch(() => false);

const ctx: TenantContext = { workspaceId: asId(randomUUID()), userId: asId("user-1") };

const FORM = `<!doctype html><title>Sign up</title>
<h1>Join the list</h1>
<p>We send one email a month.</p>
<form onsubmit="event.preventDefault(); document.querySelector('h1').textContent = 'Thanks, ' + this.name.value; document.body.dataset.done = '1'">
  <label>Name <input name="name"></label>
  <label><input type="checkbox" name="news"> Monthly news</label>
  <button>Join</button>
</form>`;

/** The start of a VNC session (RFB 3.8, no password): the server's version and screen size. */
async function vncHandshake(stream: DesktopStream) {
  let buffer = new Uint8Array(0);
  let wake: (() => void) | undefined;
  stream.onData((chunk) => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
    wake?.();
  });
  const read = async (n: number) => {
    while (buffer.length < n) await new Promise<void>((resolve) => (wake = resolve));
    const out = buffer.slice(0, n);
    buffer = buffer.slice(n);
    return out;
  };
  const version = new TextDecoder().decode(await read(12));
  stream.send(new TextEncoder().encode("RFB 003.008\n"));
  const [count = 0] = await read(1);
  expect([...(await read(count))]).toContain(1); // Security type "None".
  stream.send(Uint8Array.of(1));
  expect([...(await read(4))]).toEqual([0, 0, 0, 0]); // Security result: OK.
  stream.send(Uint8Array.of(1)); // ClientInit: shared.
  const init = await read(4);
  return { version, width: (init[0]! << 8) | init[1]!, height: (init[2]! << 8) | init[3]! };
}

describe.skipIf(!up)("Docker sandbox (integration)", { timeout: 60_000 }, () => {
  const sandbox = createDockerSandbox({ url, token });
  let handle: Awaited<ReturnType<typeof sandbox.acquire>>;
  // Fixed IDs, so repeated runs reuse two users instead of adding more.
  const alice = asId<AgentId>("00000000-0000-4000-8000-00000000a11c");
  const bob = asId<AgentId>("00000000-0000-4000-8000-000000000b0b");

  beforeAll(async () => {
    handle = await sandbox.acquire(ctx);
    expect(await handle.health()).toMatchObject({ ok: true });
  });

  it("runs commands as the agent's own unprivileged user, in the shared workspace", async () => {
    const result = await handle.exec(
      alice,
      "id -u; id -Gn; pwd; echo $HOME; env | grep -ci token || true",
    );
    const [uid, groups, cwd, home, tokens] = result.stdout.trim().split("\n");
    expect(Number(uid)).toBeGreaterThan(10000);
    expect(groups).toContain("agents");
    expect(cwd).toBe("/workspace");
    expect(home).toBe(`/home/agents/${uid}`);
    expect(tokens).toBe("0"); // The service's token never reaches agents.
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("keeps each agent's home private and shares the workspace", async () => {
    await handle.exec(alice, "echo private > ~/diary.txt");
    const aliceHome = (await handle.exec(alice, "echo $HOME")).stdout.trim();
    const peek = await handle.exec(bob, `cat ${aliceHome}/diary.txt`);
    expect(peek.exitCode).not.toBe(0);
    expect(peek.stderr).toContain("Permission denied");

    const name = `handoff-${randomUUID()}.txt`;
    await handle.writeFile(alice, name, "from alice\n");
    expect(new TextDecoder().decode(await handle.readFile(bob, name))).toBe("from alice\n");
    expect((await handle.exec(bob, `echo "and bob" >> ${name} && cat ${name}`)).stdout).toBe(
      "from alice\nand bob\n",
    );
    const { entries } = await handle.listFiles(bob, ".");
    expect(entries).toContainEqual(expect.objectContaining({ name, type: "file" }));
  });

  it("runs Python in the agent's own venv, with Word and Excel libraries", async () => {
    const result = await handle.exec(
      alice,
      [
        "command -v python3 pip",
        'python3 -c "import sys; print(sys.prefix)"',
        "python3 - <<'EOF'",
        "import docx, openpyxl",
        "book = openpyxl.Workbook(); book.active.append(['Model', 'GPU']); book.save('/tmp/venv-check.xlsx')",
        "doc = docx.Document(); doc.add_heading('Report', 0); doc.save('/tmp/venv-check.docx')",
        "print(openpyxl.load_workbook('/tmp/venv-check.xlsx').active['B1'].value)",
        "print(docx.Document('/tmp/venv-check.docx').paragraphs[0].text)",
        "EOF",
        "rm -f /tmp/venv-check.xlsx /tmp/venv-check.docx",
      ].join("\n"),
    );
    const home = (await handle.exec(alice, "echo $HOME")).stdout.trim();
    expect(result.stdout.trim().split("\n")).toEqual([
      `${home}/.venv/bin/python3`,
      `${home}/.venv/bin/pip`,
      `${home}/.venv`, // So `pip install` lands in the agent's private home.
      "GPU",
      "Report",
    ]);
  });

  it("reads ~ in file paths as the agent's own home", async () => {
    await handle.writeFile(alice, "~/notes/tilde.txt", "mine\n");
    expect((await handle.exec(alice, "cat ~/notes/tilde.txt")).stdout).toBe("mine\n");
    expect(new TextDecoder().decode(await handle.readFile(alice, "~/notes/tilde.txt"))).toBe(
      "mine\n",
    );
    const { entries } = await handle.listFiles(alice, "~/notes");
    expect(entries.map((e) => e.name)).toContain("tilde.txt");
    // Another agent's ~ is its own.
    await expect(handle.readFile(bob, "~/notes/tilde.txt")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("can't write outside what the agent owns", async () => {
    await expect(handle.writeFile(alice, "/etc/evil", "x")).rejects.toBeInstanceOf(SandboxError);
    expect((await handle.exec(alice, "touch /opt/sandbox/x")).exitCode).not.toBe(0);
  });

  it("stops a command at its time limit and caps its output", async () => {
    const slow = await handle.exec(alice, "sleep 30", { timeoutMs: 1_500 });
    expect(slow.timedOut).toBe(true);
    const loud = await handle.exec(alice, "head -c 400000 /dev/zero | tr '\\0' a");
    expect(loud.truncated).toBe(true);
    expect(loud.stdout.length).toBe(256 * 1024);
  });

  it("goes out only through the egress proxy, and never to private addresses", async () => {
    const result = await handle.exec(
      alice,
      [
        "curl -sS -m 5 http://postgres:5432 2>&1 | head -1",
        "curl -sS -m 5 http://169.254.169.254/ 2>&1 | head -1",
        "curl -sS -m 5 --noproxy '*' https://example.com 2>&1 | head -1",
      ].join("; "),
    );
    const [port, metadata, direct] = result.stdout.trim().split("\n");
    expect(port).toContain("port 5432 is not allowed");
    expect(metadata).toContain("private address");
    expect(direct).toContain("Could not resolve host"); // No route except the proxy.
  });

  it("drives the agent's browser: opens a page, reads it, fills a form and submits it", async () => {
    const browser = await handle.browser(alice);
    const page = await browser.open(`data:text/html,${encodeURIComponent(FORM)}`);
    expect(page.title).toBe("Sign up");
    expect(page.outline).toContain("# Join the list");
    expect(page.outline).toContain("We send one email a month.");
    const ref = (label: string) => {
      const match = new RegExp(`\\[(\\d+)\\] ${label}`).exec(page.outline);
      if (!match) throw new Error(`no ${label} in\n${page.outline}`);
      return Number(match[1]);
    };

    const typed = await browser.type(ref('textbox "Name"'), "Sam");
    expect(typed.outline).toContain('textbox "Name" value="Sam"');
    const ticked = await browser.click(ref('checkbox "Monthly news"'));
    expect(ticked.outline).toContain('checkbox "Monthly news" (checked');
    expect(ticked.outline).not.toMatch(/^Name$/m); // The label isn't repeated before its box.
    const done = await browser.click(ref('button "Join"'));
    expect(done.outline).toContain("# Thanks, Sam");

    await expect(browser.click(999_999)).rejects.toMatchObject({ code: "no_element" });
    await expect(browser.press("F13")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("puts a light desktop on the agent's screen, run as the agent and closed to others", async () => {
    await handle.browser(alice);
    const running = await handle.exec(
      alice,
      'for p in Xvfb dbus-daemon openbox pcmanfm tint2 chromium; do pgrep -u "$(id -u)" -x "$p" >/dev/null && echo "$p"; done',
    );
    expect(running.stdout.trim().split("\n")).toEqual([
      "Xvfb",
      "dbus-daemon",
      "openbox",
      "pcmanfm",
      "tint2",
      "chromium",
    ]);
    // Chromium is a window on it, and the agent's own programs reach the screen.
    const own = await handle.exec(
      alice,
      "xdotool getdisplaygeometry; xdotool search --onlyvisible --class chromium | wc -l",
    );
    const [geometry, windows] = own.stdout.trim().split("\n");
    expect(geometry).toBe("1280 800");
    expect(Number(windows)).toBeGreaterThan(0);
    // Another agent can't open it: the display has a key only its agent reads.
    const display = (await handle.exec(alice, "echo $DISPLAY")).stdout.trim();
    const peek = await handle.exec(bob, `DISPLAY=${display} xdotool getdisplaygeometry`);
    expect(peek.exitCode).not.toBe(0);
  });

  it("shows the agent's commands in its terminal while its desktop is up, with the same results", async () => {
    await handle.browser(alice); // The desktop is up.
    const marker = `shown-${randomUUID().slice(0, 8)}`;
    const result = await handle.exec(alice, `echo ${marker}; echo oops >&2; cat; exit 3`);
    // Same as an unseen run: both streams apart, the exit code, stdin closed.
    expect(result).toMatchObject({
      exitCode: 3,
      stdout: `${marker}\n`,
      stderr: "oops\n",
      timedOut: false,
    });
    // And it is on screen: a tab in the agent's terminal, which is open.
    const screen = await handle.exec(
      alice,
      "for w in $(tmux list-windows -t work -F '#{window_id}'); do tmux capture-pane -p -t \"$w\"; done; xdotool search --onlyvisible --class AgentTerminal | wc -l",
    );
    expect(screen.stdout).toContain(marker);
    expect(screen.stdout.trim().split("\n").at(-1)).not.toBe("0");
    // The folder and time limit behave as before.
    expect((await handle.exec(alice, "pwd")).stdout).toBe("/workspace\n");
    const slow = await handle.exec(alice, "sleep 30 & sleep 30", { timeoutMs: 1_500 });
    expect(slow.timedOut).toBe(true);
    expect(
      (await handle.exec(alice, 'pgrep -c -u "$(id -u)" -x sleep || true')).stdout.trim(),
    ).toBe("0");
  });

  it("opens files in their apps on the agent's desktop, never in the browser", async () => {
    const made = await handle.exec(
      alice,
      [
        "mkdir -p open-check && cd open-check",
        "python3 -c \"import docx, openpyxl; d = docx.Document(); d.add_heading('Report', 0); d.save('r.docx'); b = openpyxl.Workbook(); b.active.append(['a', 1]); b.save('s.xlsx')\"",
        "printf 'notes' > n.txt; printf '<img src=https://example.com/x>' > p.html",
        "printf '%%PDF-1.4\\n\\000\\001' > d.pdf",
        "scrot i.png", // A real image: the desktop itself.
      ].join(" && "),
    );
    expect(made.exitCode).toBe(0);
    const apps: Record<string, string> = {};
    for (const name of ["r.docx", "s.xlsx", "n.txt", "p.html", "i.png", "."]) {
      apps[name] = (await handle.openFile(alice, `open-check/${name}`)).app;
    }
    expect(apps).toEqual({
      "r.docx": "abiword",
      "s.xlsx": "gnumeric",
      "n.txt": "mousepad",
      "p.html": "mousepad", // As text: the browser would fetch what it points at.
      "i.png": "feh",
      ".": "pcmanfm",
    });
    await expect(handle.openFile(alice, "open-check/d.pdf")).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(handle.openFile(alice, "open-check/missing.docx")).rejects.toMatchObject({
      code: "not_found",
    });
    const running = await handle.exec(
      alice,
      `sleep 1; for p in abiword gnumeric mousepad feh; do pgrep -u "$(id -u)" -x "$p" >/dev/null && echo "$p"; done; pkill -u "$(id -u)" -x abiword; pkill -u "$(id -u)" -x gnumeric; pkill -u "$(id -u)" -x mousepad; pkill -u "$(id -u)" -x feh; xdotool search --onlyvisible --name '^open-check$' | while read w; do xdotool windowactivate --sync "$w" key ctrl+w; done; rm -rf /workspace/open-check`,
    );
    expect(running.stdout.trim().split("\n")).toEqual(["abiword", "gnumeric", "mousepad", "feh"]);
  });

  it("reads and drives desktop apps through their accessibility tree", async () => {
    const name = `a11y-${randomUUID().slice(0, 8)}.txt`;
    await handle.writeFile(alice, name, "first draft");
    expect((await handle.openFile(alice, name)).app).toBe("mousepad");
    const apps = await handle.desktopApps(alice);
    let snapshot = await apps.snapshot();
    for (let i = 0; i < 20 && !snapshot.title.includes(name); i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      snapshot = await apps.snapshot();
    }
    expect(snapshot.title).toContain(name);
    expect(snapshot.outline).toContain('menu "File"');
    const field = /\[(\d+)\] text \(focused\) value="first draft"/.exec(snapshot.outline);
    if (!field) throw new Error(`no text field in\n${snapshot.outline}`);
    // Replace the text and save with the keyboard, as a person would.
    const typed = await apps.type(Number(field[1]), "edited through the tree", { clear: true });
    expect(typed.outline).toContain('value="edited through the tree"');
    await apps.press("ctrl+s");
    await new Promise((r) => setTimeout(r, 500));
    expect(new TextDecoder().decode(await handle.readFile(alice, name))).toBe(
      "edited through the tree",
    );
    // A number from an old snapshot fails clearly.
    await expect(apps.click(99_999)).rejects.toMatchObject({ code: "no_element" });
    // GTK2 apps (the file manager) are in the tree too.
    await handle.openFile(alice, ".");
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await apps.snapshot()).outline).toMatch(/frame "workspace"/);
    await handle.exec(
      alice,
      `pkill -u "$(id -u)" -x mousepad; xdotool search --onlyvisible --name '^workspace$' | while read w; do xdotool windowactivate --sync "$w" key ctrl+w; done; rm -f ${name}`,
    );
  });

  it("takes screenshots, clicks at fractions of the screen and types (the fallback)", async () => {
    const name = `shot-${randomUUID().slice(0, 8)}.txt`;
    await handle.writeFile(alice, name, "");
    await handle.openFile(alice, name);
    const apps = await handle.desktopApps(alice);
    let shot = await apps.screenshot();
    for (let i = 0; i < 20 && !shot.title.includes(name); i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      shot = await apps.screenshot();
    }
    expect(shot.title).toContain(name);
    expect([shot.width, shot.height, shot.mediaType]).toEqual([1280, 800, "image/jpeg"]);
    const jpeg = Buffer.from(shot.data, "base64");
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]); // A JPEG.
    expect(jpeg.length).toBeGreaterThan(5_000);
    // Fractions of the screen; pixels when above 1.
    expect((await apps.clickAt(0.5, 0.25)).clicked).toEqual([640, 200]);
    expect((await apps.clickAt(100, 50)).clicked).toEqual([100, 50]);
    // A click may have brought another window forward (it did: the Agent
    // terminal, which the tree can't read, and the snapshot says so).
    let desk = await apps.snapshot();
    const frame = desk.outline
      .split("\n")
      .find((l) => /^\[\d+\] frame/.test(l) && l.includes(name));
    if (!frame) throw new Error(`no editor window in\n${desk.outline}`);
    if (!frame.includes("in front")) desk = await apps.click(Number(/\[(\d+)\]/.exec(frame)![1]));
    // Type into the editor (focused through the tree) and save.
    const lines = desk.outline.split("\n");
    const end = lines.findIndex((l, i) => i > 0 && /^\[\d+\]/.test(l));
    const field = /\[(\d+)\] text/.exec(lines.slice(0, end === -1 ? undefined : end).join("\n"));
    if (!field) throw new Error(`no text field in\n${desk.outline}`);
    await apps.click(Number(field[1]));
    const after = await apps.typeText("typed from a screenshot");
    expect(after.data.length).toBeGreaterThan(1_000);
    await apps.press("ctrl+s");
    await new Promise((r) => setTimeout(r, 500));
    expect(new TextDecoder().decode(await handle.readFile(alice, name))).toContain(
      "typed from a screenshot",
    );
    await handle.exec(alice, `pkill -u "$(id -u)" -x mousepad; rm -f ${name}`);
  });

  it("streams the agent's desktop to a watcher over VNC, on no TCP port", async () => {
    const stream = await handle.desktop(alice, { control: false });
    try {
      const { version, width, height } = await vncHandshake(stream);
      expect(version).toBe("RFB 003.008\n");
      expect([width, height]).toEqual([1280, 800]);
      // The viewer's server listens only on a socket that agent and the
      // service can reach: no port another agent could connect to.
      const tcp = await handle.exec(bob, "cat /proc/net/tcp /proc/net/tcp6");
      expect(tcp.stdout).not.toMatch(/:170C 0+:0000 0A/); // 5900, listening
      const uid = (await handle.exec(alice, "id -u")).stdout.trim();
      const peek = await handle.exec(bob, `ls /run/ofa-vnc/${uid}`);
      expect(peek.stderr).toContain("Permission denied");
    } finally {
      stream.close();
    }
  });

  it("gives control of the desktop only during a takeover, and holds the agent meanwhile", async () => {
    await expect(handle.desktop(alice, { control: true })).rejects.toMatchObject({
      code: "taken_over",
    });
    await handle.takeover(alice, true);
    try {
      const stream = await handle.desktop(alice, { control: true });
      expect((await vncHandshake(stream)).width).toBe(1280);
      stream.close();
      await expect(handle.exec(alice, "echo hi")).rejects.toMatchObject({ code: "taken_over" });
      await expect(handle.writeFile(alice, "held.txt", "x")).rejects.toMatchObject({
        code: "taken_over",
      });
    } finally {
      await handle.takeover(alice, false);
    }
    expect((await handle.exec(alice, "echo back")).stdout).toBe("back\n");
  });

  it("opens no DevTools port another agent could use: the browser is driven over a pipe", async () => {
    await handle.browser(alice);
    const uid = (await handle.exec(alice, "id -u")).stdout.trim();
    // No listening TCP socket at all owned by Alice's processes, and no
    // debugging port on her browser's command line.
    const probe = await handle.exec(
      bob,
      [
        `ps -o args= -u ${uid} | grep -c -- '--remote-debugging-port' || true`,
        `ps -o args= -u ${uid} | grep -c -- '--remote-debugging-pipe' || true`,
        "cat /proc/net/tcp /proc/net/tcp6 | awk '$4 == \"0A\"' | wc -l",
      ].join("; "),
    );
    const [port, pipe, listening] = probe.stdout.trim().split("\n").map(Number);
    expect(port).toBe(0);
    expect(pipe).toBeGreaterThan(0);
    // Only the sandbox service's own port (and Docker's DNS) listen.
    expect(listening).toBeLessThanOrEqual(2);
    // Two connections at once (an agent's tool and a person's view) each get their own replies.
    const [a, b] = await Promise.all([handle.browser(alice), handle.browser(alice)]);
    const [one, two] = await Promise.all([
      a.open(`data:text/html,${encodeURIComponent("<title>One</title><h1>One</h1>")}`),
      b.snapshot(),
    ]);
    expect(one.title).toBe("One");
    expect(two.url).toBeTruthy();
  });

  it("can't open private addresses in the browser either", async () => {
    const browser = await handle.browser(alice);
    await expect(browser.open("http://10.0.0.1/")).rejects.toMatchObject({
      code: "navigation_failed",
    });
  });

  it("keeps browser profiles apart, and shares one site's login only when asked", async () => {
    const endpoint = async (id: AgentId) => {
      const response = await fetch(`${url}/browser`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: id }),
      });
      const { path } = (await response.json()) as { path: string };
      return `${url.replace(/^http/, "ws")}${path}?token=${token}`;
    };
    const cookies = async (id: AgentId) => {
      const cdp = await connectCdp(await endpoint(id));
      try {
        return (
          await cdp.send<{ cookies: { name: string; domain: string }[] }>("Storage.getCookies")
        ).cookies;
      } finally {
        cdp.close();
      }
    };
    const cdp = await connectCdp(await endpoint(alice));
    await cdp.send("Storage.setCookies", {
      cookies: [
        { name: "session", value: "s3cr3t", domain: ".example.com", path: "/" },
        { name: "other", value: "x", domain: "other.example", path: "/" },
      ],
    });
    cdp.close();

    expect((await cookies(bob)).some((c) => c.name === "session")).toBe(false);
    expect(await handle.shareLogin(alice, bob, "example.com")).toEqual({ cookies: 1 });
    const shared = await cookies(bob);
    expect(shared.some((c) => c.name === "session")).toBe(true);
    expect(shared.some((c) => c.name === "other")).toBe(false);
  });

  it("refuses a wrong token", async () => {
    const wrong = createDockerSandbox({ url, token: "not-the-token-at-all" });
    const other = await wrong.acquire(ctx);
    await expect(other.exec(alice, "id")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("stops an agent's processes on restart", async () => {
    void handle.exec(bob, "sleep 120", { timeoutMs: 130_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await handle.restart(bob);
    expect((await handle.exec(bob, 'pgrep -c -u "$(id -u)" -x sleep || true')).stdout.trim()).toBe(
      "0",
    );
  });
});
