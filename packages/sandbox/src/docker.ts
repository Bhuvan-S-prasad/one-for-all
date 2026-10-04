import {
  SandboxError,
  type AgentId,
  type ExecResult,
  type FileEntry,
  type SandboxHandle,
  type SandboxProvider,
} from "@ofa/core";
import { copyCookies, createCdpBrowser } from "./browser";
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
    if (!response.ok) {
      if (response.status === 401) {
        throw new SandboxError("unavailable", "The app and the sandbox disagree on SANDBOX_TOKEN.");
      }
      if (response.status === 423) {
        throw new SandboxError(
          "taken_over",
          "A person has taken over your browser right now. Stop and tell them what you need, or try again after they hand it back.",
        );
      }
      throw new SandboxError(
        ERROR_CODES[response.status] ?? "unavailable",
        payload.error ?? `The computer answered ${response.status}`,
      );
    }
    return payload;
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

    async listFiles(agentId, path) {
      return call<{ entries: FileEntry[]; truncated: boolean }>("/files/list", {
        agent: agentId,
        path,
      });
    },

    async browser(agentId) {
      return createCdpBrowser(() => cdpUrl(agentId));
    },

    async shareLogin(from, to, domain) {
      const cookies = await copyCookies(await cdpUrl(from, true), await cdpUrl(to, true), domain);
      return { cookies };
    },

    async screen(agentId) {
      return createScreenSession(await cdpUrl(agentId, true));
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
