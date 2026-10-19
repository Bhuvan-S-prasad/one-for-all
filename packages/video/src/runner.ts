import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Where the engine's commands run (ADR-0049): the machine that has the
// media. One-for-All runs them in the agent's computer; standalone, they run
// here. Commands are argument lists; a runner that needs a shell quotes them
// with `quoteCommand`.

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Runner {
  run(argv: readonly string[], options?: { readonly timeoutMs?: number }): Promise<RunResult>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** An environment variable where the commands run (HOME, OFA_VIDEO_PYTHON). */
  env(name: string): Promise<string | undefined>;
}

/** One argument for a POSIX shell, single-quoted. */
export function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function quoteCommand(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

/** Commands on this machine, with no shell in between. */
export function localRunner(): Runner {
  return {
    run(argv, options = {}) {
      return new Promise((resolve, reject) => {
        const [cmd, ...args] = argv;
        if (!cmd) return reject(new Error("No command"));
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (b: Buffer) => out.push(b));
        child.stderr.on("data", (b: Buffer) => err.push(b));
        const timer = options.timeoutMs
          ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
          : undefined;
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            code: code ?? 1,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
          });
        });
      });
    },
    async writeFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    async readFile(path) {
      return new Uint8Array(await readFile(path));
    },
    async env(name) {
      if (name === "HOME") return process.env.HOME ?? homedir();
      return process.env[name];
    },
  };
}
