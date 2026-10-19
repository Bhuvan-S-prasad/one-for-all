import {
  SandboxError,
  type AgentId,
  type DesktopScreenshot,
  type DesktopSnapshot,
  type ExecResult,
  type FileEntry,
  type SandboxHandle,
  type SandboxProvider,
} from "@ofa/core";
import { copyCookies, createCdpBrowser } from "./browser";
import { openDesktopStream } from "./desktop";
import { createScreenSession } from "./screen";

// The Docker sandbox (M3.03, ADR-0025): the agents' computer is a long-lived
// container in the Compose bundle, and this adapter talks to the service
// inside it (`infra/docker/sandbox/server.mjs`). The app never gets the
// Docker socket: it cannot start, stop or reconfigure containers, only ask
// the sandbox service, which runs everything as the agent that asked.
//
// One computer per install. Self-host has one owner (ADR-0001); a computer
// per person is the cloud adapter's job (E2B).

export interface DockerSandboxOptions {
  /** The sandbox service, e.g. `http://egress:7070` (reached through the egress container). */
  readonly url: string;
  /** Shared secret with the service. Never shown to agents or put in results. */
  readonly token: string;
  readonly fetch?: typeof fetch;
}

const ERROR_CODES: Record<number, SandboxError["code"]> = {
  400: "bad_request",
  404: "not_found",
  // A desktop control from an old snapshot (DT.09).
  410: "no_element",
  413: "too_large",
  503: "unavailable",
  507: "unavailable",
};

export function createDockerSandbox(options: DockerSandboxOptions): SandboxProvider {
  const base = options.url.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function call<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new SandboxError("timeout", "The agents' computer did not answer in time.");
      }
      throw new SandboxError(
        "unavailable",
        "The agents' computer is not reachable. Is the sandbox running?",
      );
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) throw refusal(response.status, payload.error);
    return payload;
  }

  function refusal(status: number, error: string | undefined): SandboxError {
    if (status === 401) {
      return new SandboxError("unavailable", "The app and the sandbox disagree on SANDBOX_TOKEN.");
    }
    if (status === 423) {
      return new SandboxError(
        "taken_over",
        "A person has taken over your computer right now. Stop and tell them what you need, or try again after they hand it back.",
      );
    }
    return new SandboxError(
      ERROR_CODES[status] ?? "unavailable",
      error ?? `The computer answered ${status}`,
    );
  }

  /** A raw-bytes request to `/files/raw` (ADR-0047). */
  async function raw(method: "GET" | "PUT", agentId: AgentId, path: string, init: RequestInit = {}) {
    const url = new URL(`${base}/files/raw`);
    url.searchParams.set("agent", agentId);
    url.searchParams.set("path", path);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        method,
        headers: { authorization: `Bearer ${options.token}`, ...init.headers },
        // A large file takes a while either way; minutes, not hours.
        signal: AbortSignal.timeout(30 * 60_000),
      });
    } catch {
      throw new SandboxError(
        "unavailable",
        "The agents' computer is not reachable. Is the sandbox running?",
      );
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw refusal(response.status, payload.error);
    }
    return response;
  }

  /**
   * The agent's CDP endpoint as a WebSocket URL, starting its browser if
   * needed. `person`: a person's view, which takeover does not lock out.
   */
  async function cdpUrl(agentId: AgentId, person = false): Promise<string> {
    const { path } = await call<{ path: string }>("/browser", { agent: agentId, person });
    const url = new URL(path, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", options.token);
    return url.toString();
  }

  const handle: SandboxHandle = {
    id: "docker",

    async exec(agentId, command, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 60_000;
      return call<ExecResult>(
        "/exec",
        { agent: agentId, command, cwd: opts.cwd, timeoutMs },
        timeoutMs + 15_000,
      );
    },

    async readFile(agentId, path) {
      const { content } = await call<{ content: string }>("/files/read", { agent: agentId, path });
      return new Uint8Array(Buffer.from(content, "base64"));
    },

    async writeFile(agentId, path, content) {
      await call("/files/write", {
        agent: agentId,
        path,
        content: Buffer.from(content).toString("base64"),
      });
    },

    async readFileStream(agentId, path) {
      const response = await raw("GET", agentId, path);
      if (!response.body) throw new SandboxError("unavailable", "The computer sent no file.");
      return { body: response.body, size: Number(response.headers.get("content-length") ?? 0) };
    },

    async writeFileStream(agentId, path, body, size) {
      const response = await raw("PUT", agentId, path, {
        body: ReadableStream.from(body),
        headers: { "content-type": "application/octet-stream", "content-length": String(size) },
        duplex: "half",
      } as RequestInit);
      await response.body?.cancel();
    },

    async listFiles(agentId, path) {
      return call<{ entries: FileEntry[]; truncated: boolean }>("/files/list", {
        agent: agentId,
        path,
      });
    },

    async browser(agentId) {
      return createCdpBrowser(() => cdpUrl(agentId));
    },

    async openFile(agentId, path) {
      return call<{ app: string }>("/open", { agent: agentId, path });
    },

    async desktopApps(agentId) {
      const act = <T = DesktopSnapshot>(request: Record<string, unknown>) =>
        call<T>("/apps", { agent: agentId, request }, 75_000);
      return {
        snapshot: () => act({ action: "snapshot" }),
        click: (ref) => act({ action: "click", ref }),
        type: (ref, text, options = {}) =>
          act({
            action: "type",
            ref,
            text,
            clear: options.clear ?? false,
            submit: options.submit ?? false,
          }),
        press: (keys) => act({ action: "press", keys }),
        describe: (ref) =>
          act<{ window: string; element: { role: string; name: string } }>({
            action: "describe",
            ref,
          }),
        screenshot: () => act<DesktopScreenshot>({ action: "screenshot" }),
        clickAt: (x, y, options = {}) =>
          act<DesktopScreenshot>({ action: "click_at", x, y, double: options.double ?? false }),
        typeText: (text, options = {}) =>
          act<DesktopScreenshot>({ action: "type_text", text, submit: options.submit ?? false }),
      };
    },

    async shareLogin(from, to, domain) {
      const cookies = await copyCookies(await cdpUrl(from, true), await cdpUrl(to, true), domain);
      return { cookies };
    },

    async screen(agentId) {
      return createScreenSession(await cdpUrl(agentId, true));
    },

    async desktop(agentId, { control }) {
      return openDesktopStream({ url: base, token: options.token, agentId, control });
    },

    async takeover(agentId, on) {
      await call("/takeover", { agent: agentId, on });
    },

    async restart(agentId) {
      await call("/restart", agentId ? { agent: agentId } : {});
    },

    async health() {
      try {
        const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
        const body = (await response.json()) as { ok?: boolean; version?: string };
        return { ok: response.ok && body.ok === true, version: body.version };
      } catch {
        return { ok: false };
      }
    },
  };

  return {
    acquire: async () => handle,
    pause: async () => handle.restart(),
    release: async () => handle.restart(),
  };
}
