import { spawnSync } from "node:child_process";

// The vault key in the OS keychain (ADR-0012, M4.02), for running from
// source on a desktop: macOS Keychain, the Secret Service on Linux (GNOME
// Keyring, KWallet) and Windows Credential Manager. Each uses a tool the OS
// already has, so there is no native module to build. The key travels on
// stdin, never in a command line another process could read. Containers have
// no keychain; the self-host bundle keeps `VAULT_KEY` in its env file.

export const KEYCHAIN_SERVICE = "one-for-all";

/** The current key, and the one it replaced while a rotation finishes. */
export type KeychainEntry = "vault-key" | "vault-key.previous";

export interface Keychain {
  read(entry: KeychainEntry): string | null;
  write(entry: KeychainEntry, value: string): void;
  remove(entry: KeychainEntry): void;
}

export class KeychainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeychainError";
  }
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: Error;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  input?: string,
) => CommandResult;

const runCommand: CommandRunner = (file, args, input) => {
  const result = spawnSync(file, args, {
    input: input ?? "",
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  // stderr is dropped on purpose: it can echo what was typed.
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
};

// Windows: Credential Manager through its Win32 API, compiled by PowerShell.
// A generic credential, persisted for this user on this machine.
const WINDOWS_CRED = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OfaCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static void Write(string target, string value) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.Persist = 2; c.TargetName = target; c.UserName = "one-for-all";
    c.CredentialBlobSize = value.Length * 2;
    c.CredentialBlob = Marshal.StringToCoTaskMemUni(value);
    try { if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(); }
    finally { Marshal.FreeCoTaskMem(c.CredentialBlob); }
  }
  public static void Delete(string target) { CredDeleteW(target, 1, 0); }
}
"@
`;

function powershell(script: string): readonly string[] {
  // -EncodedCommand takes UTF-16LE base64, which sidesteps quoting.
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(WINDOWS_CRED + script, "utf16le").toString("base64"),
  ];
}

export interface OsKeychainOptions {
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
  /** Tests use their own service name, so they never touch the real entries. */
  readonly service?: string;
}

/** The keychain on this OS, or an error naming what's missing. */
export function createOsKeychain(options: OsKeychainOptions = {}): Keychain {
  const { platform = process.platform, run = runCommand, service = KEYCHAIN_SERVICE } = options;
  if (!/^[a-z0-9-]+$/.test(service))
    throw new KeychainError(`Bad keychain service name: ${service}`);
  const check = (result: CommandResult, what: string, tool: string): CommandResult => {
    if (result.error) {
      throw new KeychainError(`Couldn't ${what} the OS keychain: ${tool} is not available.`);
    }
    if (result.status !== 0) {
      throw new KeychainError(
        `Couldn't ${what} the OS keychain (${tool} exited ${result.status}).`,
      );
    }
    return result;
  };

  switch (platform) {
    case "darwin":
      return {
        read(entry) {
          const result = run("security", [
            "find-generic-password",
            "-s",
            service,
            "-a",
            entry,
            "-w",
          ]);
          if (result.status === 44) return null; // not found
          return check(result, "read from", "security").stdout.trim() || null;
        },
        write(entry, value) {
          // `security -i` reads commands from stdin, keeping the key out of argv.
          check(
            run(
              "security",
              ["-i"],
              `add-generic-password -U -s ${service} -a ${entry} -w ${value}\n`,
            ),
            "write to",
            "security",
          );
        },
        remove(entry) {
          run("security", ["delete-generic-password", "-s", service, "-a", entry]);
        },
      };
    case "linux": {
      const attrs = (entry: KeychainEntry) => ["service", service, "account", entry];
      return {
        read(entry) {
          const result = run("secret-tool", ["lookup", ...attrs(entry)]);
          if (!result.error && result.status === 1) return null; // not found
          return check(result, "read from", "secret-tool").stdout.trim() || null;
        },
        write(entry, value) {
          check(
            run(
              "secret-tool",
              ["store", "--label", `One-for-All ${entry}`, ...attrs(entry)],
              value,
            ),
            "write to",
            "secret-tool",
          );
        },
        remove(entry) {
          run("secret-tool", ["clear", ...attrs(entry)]);
        },
      };
    }
    case "win32": {
      const target = (entry: KeychainEntry) => `${service}:${entry}`;
      return {
        read(entry) {
          const result = run(
            "powershell.exe",
            powershell(
              `$v = [OfaCred]::Read('${target(entry)}'); if ($null -eq $v) { exit 3 }; [Console]::Out.Write($v)`,
            ),
          );
          if (!result.error && result.status === 3) return null; // not found
          return check(result, "read from", "PowerShell").stdout.trim() || null;
        },
        write(entry, value) {
          check(
            run(
              "powershell.exe",
              powershell(`[OfaCred]::Write('${target(entry)}', [Console]::In.ReadToEnd().Trim())`),
              value,
            ),
            "write to",
            "PowerShell",
          );
        },
        remove(entry) {
          run("powershell.exe", powershell(`[OfaCred]::Delete('${target(entry)}')`));
        },
      };
    }
    default:
      throw new KeychainError(`There is no OS keychain support for ${platform}; use VAULT_KEY.`);
  }
}

export interface VaultKeySettings {
  /** Where the current key comes from (`VAULT_KEY_SOURCE`). */
  readonly source: "env" | "keychain";
  /** `VAULT_KEY`, when the source is `env`. */
  readonly key?: string;
  /** `VAULT_PREVIOUS_KEYS`: earlier keys kept while a rotation finishes. */
  readonly previousKeys: readonly string[];
}

export interface VaultKeys {
  readonly source: "env" | "keychain";
  readonly key: string;
  readonly previousKeys: readonly string[];
}

/**
 * The keys to open the vault with, or null when none is configured. With the
 * keychain as source, a missing key is an error rather than a vault that
 * silently can't decrypt.
 */
export function resolveVaultKeys(
  settings: VaultKeySettings,
  keychain: () => Keychain = () => createOsKeychain(),
): VaultKeys | null {
  if (settings.source === "env") {
    return settings.key
      ? { source: "env", key: settings.key, previousKeys: settings.previousKeys }
      : null;
  }
  const chain = keychain();
  const key = chain.read("vault-key");
  if (!key) {
    throw new KeychainError(
      "VAULT_KEY_SOURCE is keychain, but the OS keychain has no One-for-All vault key. Run `pnpm vault keychain:store` with VAULT_KEY set, or use VAULT_KEY.",
    );
  }
  const previous = chain.read("vault-key.previous");
  return {
    source: "keychain",
    key,
    previousKeys: [...settings.previousKeys, ...(previous ? [previous] : [])],
  };
}
