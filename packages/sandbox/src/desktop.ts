import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { SandboxError, type DesktopStream } from "@ofa/core";

// A person's view of an agent's desktop (ADR-0040): the sandbox service
// upgrades `/desktop/<agent>` to the raw VNC stream of an x11vnc it starts
// for this viewer, and this passes the bytes both ways. The app relays them
// to the person's VNC client; nothing is decoded or stored here.

const CONNECT_TIMEOUT = 30_000;

export function openDesktopStream(options: {
  readonly url: string;
  readonly token: string;
  readonly agentId: string;
  readonly control: boolean;
}): Promise<DesktopStream> {
  const target = new URL(`/desktop/${encodeURIComponent(options.agentId)}`, options.url);
  if (options.control) target.searchParams.set("control", "1");
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = request(target, {
      headers: {
        authorization: `Bearer ${options.token}`,
        connection: "Upgrade",
        upgrade: "rfb",
      },
      timeout: CONNECT_TIMEOUT,
    });
    req.on("upgrade", (_res: IncomingMessage, socket: Socket, head: Buffer) => {
      req.setTimeout(0);
      resolve(desktopStream(socket, head));
    });
    req.on("response", (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        let message = `The computer answered ${res.statusCode}`;
        try {
          message = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { error: string }).error;
        } catch {
          // Not JSON: keep the status.
        }
        reject(refusal(res.statusCode ?? 500, message));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new SandboxError("timeout", "The agents' computer did not answer in time."));
    });
    req.on("error", () =>
      reject(
        new SandboxError(
          "unavailable",
          "The agents' computer is not reachable. Is the sandbox running?",
        ),
      ),
    );
    req.end();
  });
}

function refusal(status: number, message: string): SandboxError {
  if (status === 401) {
    return new SandboxError("unavailable", "The app and the sandbox disagree on SANDBOX_TOKEN.");
  }
  if (status === 423) return new SandboxError("taken_over", message);
  if (status === 404 || status === 400) return new SandboxError("bad_request", message);
  return new SandboxError("unavailable", message);
}

function desktopStream(socket: Socket, head: Buffer): DesktopStream {
  const dataListeners = new Set<(chunk: Uint8Array<ArrayBuffer>) => void>();
  const endListeners = new Set<(reason: string) => void>();
  const pending: Uint8Array<ArrayBuffer>[] = head.length > 0 ? [new Uint8Array(head)] : [];
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    for (const listener of endListeners) listener(reason);
    socket.destroy();
  };
  socket.setNoDelay(true);
  socket.on("data", (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    // Bytes that arrive before anyone listens (the server's greeting) wait.
    if (dataListeners.size === 0) pending.push(bytes);
    else for (const listener of dataListeners) listener(bytes);
  });
  socket.on("close", () => end("The desktop view closed."));
  socket.on("error", () => end("The desktop view was cut off."));
  return {
    onData(listener) {
      dataListeners.add(listener);
      for (const bytes of pending.splice(0)) listener(bytes);
    },
    onEnd: (listener) => void endListeners.add(listener),
    send(chunk) {
      if (!ended) socket.write(chunk);
    },
    close: () => end("Closed."),
  };
}
