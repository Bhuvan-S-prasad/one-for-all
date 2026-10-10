import type { Config } from "@ofa/config";
import type { Database } from "@ofa/db";
import type { InstallRotation } from "@ofa/vault";
import { describe, expect, it } from "vitest";
import type { VaultRotation } from "../container";
import type { Logger } from "../lib/logger";
import { finishVaultRotation } from "./vault-rotation";

const KEY = Buffer.alloc(32, 1).toString("base64");
const OLD = Buffer.alloc(32, 2).toString("base64");

function setup(options: {
  source?: "env" | "keychain";
  previous?: string[];
  result?: Partial<InstallRotation>;
  fails?: boolean;
  sameUrl?: boolean;
}) {
  const lines: [string, string][] = [];
  const log = (level: string) => (message: string) => void lines.push([level, message]);
  const logger = {
    error: log("error"),
    warn: log("warn"),
    info: log("info"),
    debug: log("debug"),
  } as unknown as Logger;
  const state = { ran: 0, forgot: 0, closed: 0 };
  const rotation: VaultRotation = {
    keys: { source: options.source ?? "env", key: KEY, previousKeys: options.previous ?? [OLD] },
    run: async () => {
      state.ran += 1;
      if (options.fails) throw new Error("db down");
      return { workspaces: 1, rewrapped: 2, current: 0, unreadable: 0, ...options.result };
    },
    forgetPrevious: () => void (state.forgot += 1),
  };
  const config = {
    database: {
      url: "postgres://app@x/db",
      migrationUrl: options.sameUrl ? "postgres://app@x/db" : "postgres://owner@x/db",
    },
  } as Config;
  const openOwnerDb = () => ({
    db: {} as Database,
    close: async () => void (state.closed += 1),
  });
  return {
    lines,
    state,
    run: () => finishVaultRotation(rotation, config, logger, openOwnerDb),
  };
}

describe("finishVaultRotation", () => {
  it("does nothing without previous keys", async () => {
    const t = setup({ previous: [] });
    await t.run();
    expect(t.state.ran).toBe(0);
    expect(t.lines).toEqual([]);
  });

  it("needs the owner connection to see every workspace", async () => {
    const t = setup({ sameUrl: true });
    await t.run();
    expect(t.state.ran).toBe(0);
    expect(t.lines[0]?.[0]).toBe("warn");
  });

  it("with keys from env, says the old key can go once all is re-wrapped", async () => {
    const t = setup({});
    await t.run();
    expect(t.state).toEqual({ ran: 1, forgot: 0, closed: 1 });
    expect(t.lines[0]?.[1]).toMatch(/remove VAULT_PREVIOUS_KEYS/);
  });

  it("with the keychain, removes the old key once all is re-wrapped", async () => {
    const t = setup({ source: "keychain" });
    await t.run();
    expect(t.state.forgot).toBe(1);
  });

  it("keeps the old key while anything is unreadable, or when it fails", async () => {
    const unreadable = setup({ source: "keychain", result: { unreadable: 1 } });
    await unreadable.run();
    expect(unreadable.state.forgot).toBe(0);
    expect(unreadable.lines[0]?.[0]).toBe("warn");

    const failed = setup({ source: "keychain", fails: true });
    await failed.run();
    expect(failed.state).toEqual({ ran: 1, forgot: 0, closed: 1 });
    expect(failed.lines[0]?.[0]).toBe("error");
  });
});
