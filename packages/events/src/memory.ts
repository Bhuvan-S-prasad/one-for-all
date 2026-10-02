import type { BusEvent, EventBus } from "@ofa/core";

/** In-process bus for tests and single-process tools. Same contract as the Postgres bus. */
export function createMemoryEventBus(): EventBus & { readonly published: BusEvent[] } {
  const handlers = new Map<string, Set<(event: BusEvent) => void | Promise<void>>>();
  const published: BusEvent[] = [];

  return {
    published,
    async publish(event) {
      published.push(event);
      for (const handler of handlers.get(event.topic) ?? []) {
        // Like NOTIFY: a failing subscriber never fails the publisher.
        await Promise.resolve(handler(event)).catch(() => {});
      }
    },
    async subscribe(topic, handler) {
      const set = handlers.get(topic) ?? new Set();
      const wrapped = handler as (event: BusEvent) => void | Promise<void>;
      set.add(wrapped);
      handlers.set(topic, set);
      return async () => {
        set.delete(wrapped);
      };
    },
  };
}
