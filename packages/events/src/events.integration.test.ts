import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BusEvent } from "@ofa/core";
import { afterAll, describe, expect, it } from "vitest";
import { createPgEventBus, workspaceEvent, workspaceTopic, type BusPayload } from "./index";

// Postgres LISTEN/NOTIFY against the dev database (`pnpm infra:up`).
for (let dir = process.cwd(); dirname(dir) !== dir; dir = dirname(dir)) {
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
    if (existsSync(join(dir, ".env"))) process.loadEnvFile(join(dir, ".env"));
    break;
  }
}
const url = process.env.DATABASE_URL;

function nextEvent(
  bus: ReturnType<typeof createPgEventBus>,
  topic: string,
): Promise<{ event: Promise<BusEvent<BusPayload>>; stop: () => Promise<void> }> {
  let resolve!: (event: BusEvent<BusPayload>) => void;
  const event = new Promise<BusEvent<BusPayload>>((r) => (resolve = r));
  return bus.subscribe<BusPayload>(topic, resolve).then((stop) => ({ event, stop }));
}

describe.skipIf(!url)("Postgres event bus (integration)", () => {
  const publisher = createPgEventBus({ url: url ?? "" });
  const listener = createPgEventBus({ url: url ?? "" });

  afterAll(async () => {
    await publisher.close();
    await listener.close();
  });

  it("delivers an event to subscribers of its topic, across connections", async () => {
    const { event, stop } = await nextEvent(listener, workspaceTopic("ws_a"));
    await publisher.publish(workspaceEvent("ws_a", { kind: "run.event", runId: "r1", seq: 4 }));
    expect(await event).toEqual({
      topic: "workspace:ws_a",
      payload: { kind: "run.event", runId: "r1", seq: 4 },
    });
    await stop();
  });

  it("does not deliver another workspace's events", async () => {
    const seen: unknown[] = [];
    const stopB = await listener.subscribe(workspaceTopic("ws_b"), (e) => void seen.push(e));
    const { event, stop } = await nextEvent(listener, workspaceTopic("ws_c"));
    await publisher.publish(workspaceEvent("ws_c", { kind: "run.updated", runId: "r2" }));
    await event;
    expect(seen).toEqual([]);
    await stopB();
    await stop();
  });

  it("refuses payloads too big for NOTIFY", async () => {
    await expect(
      publisher.publish({ topic: "workspace:x", payload: { blob: "x".repeat(8_000) } }),
    ).rejects.toThrow(/too large/);
  });
});
