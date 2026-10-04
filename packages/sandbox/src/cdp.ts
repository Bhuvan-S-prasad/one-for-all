import { SandboxError } from "@ofa/core";

// A small Chrome DevTools Protocol client over the platform WebSocket: send a
// command, wait for its reply, listen for events. Enough for driving one page
// at a time; no dependency needed.

export interface CdpConnection {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  /** Calls `handler` for each event named `method`; returns a function that stops it. */
  on(
    method: string,
    handler: (params: Record<string, unknown>, sessionId?: string) => void,
  ): () => void;
  /** The next `method` event matching `match`, or null after `timeoutMs`. */
  next(
    method: string,
    options: {
      sessionId?: string;
      timeoutMs: number;
      match?: (params: Record<string, unknown>) => boolean;
    },
  ): Promise<Record<string, unknown> | null>;
  close(): void;
}

interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const COMMAND_TIMEOUT = 30_000;

export async function connectCdp(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<CdpConnection> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new SandboxError("unavailable", "Could not reach the browser in time"));
    }, options.timeoutMs ?? 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new SandboxError("unavailable", "Could not connect to the browser"));
    });
  });

  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Map<
    string,
    Set<(params: Record<string, unknown>, sessionId?: string) => void>
  >();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message: string };
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result ?? {});
    } else if (message.method) {
      for (const handler of listeners.get(message.method) ?? []) {
        handler(message.params ?? {}, message.sessionId);
      }
    }
  });
  socket.addEventListener("close", () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new SandboxError("unavailable", "The browser closed the connection"));
    }
    pending.clear();
  });

  const on: CdpConnection["on"] = (method, handler) => {
    const set = listeners.get(method) ?? new Set();
    set.add(handler);
    listeners.set(method, set);
    return () => set.delete(handler);
  };

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new SandboxError("timeout", `The browser did not answer ${method} in time`));
        }, COMMAND_TIMEOUT);
        pending.set(id, {
          resolve: resolve as (value: Record<string, unknown>) => void,
          reject,
          timer,
        });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on,
    next(method, { sessionId, timeoutMs, match }) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          stop();
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        const stop = on(method, (params, from) => {
          if (sessionId && from !== sessionId) return;
          if (match && !match(params)) return;
          clearTimeout(timer);
          stop();
          resolve(params);
        });
      });
    },
    close() {
      socket.close();
    },
  };
}
