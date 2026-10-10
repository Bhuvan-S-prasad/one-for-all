import { randomUUID } from "node:crypto";
import { asId, SandboxError, type AgentId, type TenantContext } from "@ofa/core";
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
    expect((await handle.exec(bob, "pgrep -c sleep || true")).stdout.trim()).toBe("0");
  });
});
