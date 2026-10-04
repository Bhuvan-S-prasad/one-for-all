import type { BusEvent, EventBus } from "@ofa/core";
import postgres from "postgres";

// Self-host event bus on Postgres LISTEN/NOTIFY (ADR-0007): no extra service.
// One channel carries every topic; this process holds a single LISTEN
// connection and fans events out to local subscribers by topic.

const CHANNEL = "ofa_events";
/** NOTIFY payloads must stay under 8,000 bytes. */
const MAX_PAYLOAD_BYTES = 7_900;

export interface PgEventBus extends EventBus {
  /** Stop listening and close the bus's connections. */
  close(): Promise<void>;
}

type Handler = (event: BusEvent) => void | Promise<void>;

export function createPgEventBus(options: { readonly url: string }): PgEventBus {
  // A dedicated pool of one: LISTEN holds its connection open.
  const sql = postgres(options.url, { max: 1, onnotice: () => {} });
  const handlers = new Map<string, Set<Handler>>();
  let listening: Promise<{ unlisten(): Promise<void> }> | undefined;

  function dispatch(raw: string): void {
    let event: BusEvent;
    try {
      event = JSON.parse(raw) as BusEvent;
    } catch {
      return;
    }
    for (const handler of handlers.get(event.topic) ?? []) {
      // A failing subscriber must not break delivery to the others.
      void Promise.resolve()
        .then(() => handler(event))
        .catch((error: unknown) => console.error("event bus subscriber failed", error));
    }
  }

  function ensureListening() {
    // postgres.js re-issues LISTEN after a reconnect.
    listening ??= sql.listen(CHANNEL, dispatch);
    return listening;
  }

  return {
    async publish(event) {
      const payload = JSON.stringify(event);
      if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
        throw new Error(`Bus event too large for NOTIFY (${event.topic}); send IDs, not rows`);
      }
      await sql.notify(CHANNEL, payload);
    },

    async subscribe(topic, handler) {
      await ensureListening();
      const set = handlers.get(topic) ?? new Set<Handler>();
      set.add(handler as Handler);
      handlers.set(topic, set);
      return async () => {
        set.delete(handler as Handler);
        if (set.size === 0) handlers.delete(topic);
      };
    },

    async close() {
      if (listening) await (await listening).unlisten().catch(() => {});
      await sql.end({ timeout: 5 });
    },
  };
}
