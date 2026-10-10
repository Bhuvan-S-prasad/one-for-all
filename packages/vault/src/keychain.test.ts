import { describe, expect, it } from "vitest";
import {
  createOsKeychain,
  KeychainError,
  resolveVaultKeys,
  type CommandResult,
  type Keychain,
  type KeychainEntry,
} from "./index";

// A stand-in key; never a real one.
const KEY = Buffer.alloc(32, 7).toString("base64");

function recorder(result: Partial<CommandResult> = {}) {
  const calls: { file: string; args: readonly string[]; input?: string }[] = [];
  const run = (file: string, args: readonly string[], input?: string): CommandResult => {
    calls.push({ file, args, input });
    return { status: 0, stdout: "", ...result };
  };
  return { calls, run };
}

describe("OS keychain", () => {
  it("macOS: reads with security, writes over stdin, and treats 44 as not found", () => {
    const found = recorder({ stdout: `${KEY}\n` });
    expect(createOsKeychain({ platform: "darwin", run: found.run }).read("vault-key")).toBe(KEY);
    expect(found.calls[0]?.args).toEqual([
      "find-generic-password",
      "-s",
      "one-for-all",
      "-a",
      "vault-key",
      "-w",
    ]);

    const missing = recorder({ status: 44 });
    expect(createOsKeychain({ platform: "darwin", run: missing.run }).read("vault-key")).toBeNull();

    const write = recorder();
    createOsKeychain({ platform: "darwin", run: write.run }).write("vault-key", KEY);
    expect(write.calls[0]?.args).toEqual(["-i"]);
    expect(write.calls[0]?.input).toContain(KEY);
  });

  it("Linux: uses secret-tool with the key on stdin", () => {
    const write = recorder();
    createOsKeychain({ platform: "linux", run: write.run }).write("vault-key.previous", KEY);
    expect(write.calls[0]).toMatchObject({
      file: "secret-tool",
      input: KEY,
    });
    expect(write.calls[0]?.args.join(" ")).not.toContain(KEY);
    expect(write.calls[0]?.args.slice(-4)).toEqual([
      "service",
      "one-for-all",
      "account",
      "vault-key.previous",
    ]);

    const missing = recorder({ status: 1 });
    expect(createOsKeychain({ platform: "linux", run: missing.run }).read("vault-key")).toBeNull();
  });

  it("Windows: Credential Manager through PowerShell, the key never in the command", () => {
    const write = recorder();
    createOsKeychain({ platform: "win32", run: write.run }).write("vault-key", KEY);
    const call = write.calls[0];
    expect(call?.file).toBe("powershell.exe");
    expect(call?.input).toBe(KEY);
    const encoded = call?.args[call.args.indexOf("-EncodedCommand") + 1] ?? "";
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("[OfaCred]::Write('one-for-all:vault-key'");
    expect(script).not.toContain(KEY);

    const missing = recorder({ status: 3 });
    expect(createOsKeychain({ platform: "win32", run: missing.run }).read("vault-key")).toBeNull();
  });

  it("says plainly when the tool is missing or fails, and refuses other systems", () => {
    const absent = recorder({ status: null, error: new Error("ENOENT") });
    expect(() =>
      createOsKeychain({ platform: "linux", run: absent.run }).read("vault-key"),
    ).toThrow(/secret-tool is not available/);
    const failed = recorder({ status: 2 });
    expect(() =>
      createOsKeychain({ platform: "win32", run: failed.run }).write("vault-key", KEY),
    ).toThrow(KeychainError);
    expect(() => createOsKeychain({ platform: "aix" })).toThrow(/no OS keychain support/);
    expect(() => createOsKeychain({ service: "bad name'" })).toThrow(KeychainError);
  });
});

function memoryKeychain(entries: Partial<Record<KeychainEntry, string>>): Keychain {
  return {
    read: (entry) => entries[entry] ?? null,
    write: (entry, value) => void (entries[entry] = value),
    remove: (entry) => void delete entries[entry],
  };
}

describe("resolveVaultKeys", () => {
  it("uses VAULT_KEY from the environment, or nothing", () => {
    expect(resolveVaultKeys({ source: "env", key: KEY, previousKeys: [] })).toEqual({
      source: "env",
      key: KEY,
      previousKeys: [],
    });
    expect(resolveVaultKeys({ source: "env", previousKeys: [] })).toBeNull();
  });

  it("reads the keychain, including a key being rotated out", () => {
    const old = Buffer.alloc(32, 8).toString("base64");
    const chain = memoryKeychain({ "vault-key": KEY, "vault-key.previous": old });
    expect(resolveVaultKeys({ source: "keychain", previousKeys: [] }, () => chain)).toEqual({
      source: "keychain",
      key: KEY,
      previousKeys: [old],
    });
  });

  it("fails loudly when the keychain has no key", () => {
    expect(() =>
      resolveVaultKeys({ source: "keychain", previousKeys: [] }, () => memoryKeychain({})),
    ).toThrow(/has no One-for-All vault key/);
  });
});
