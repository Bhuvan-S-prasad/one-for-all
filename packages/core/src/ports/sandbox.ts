import type { AgentId } from "../ids";
import type { TenantContext } from "../tenant";

// The agents' computer (ADR-0009, ADR-0025). One per user; every call names
// the agent it is for, because each agent works as its own user there, with
// its own home directory and browser profile (ADR-0010). Files in the shared
// workspace are visible to all of the user's agents.

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Output was cut at the sandbox's limit. */
  readonly truncated: boolean;
  /** The command ran out of time and was stopped. */
  readonly timedOut: boolean;
}

export interface FileEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "link";
  readonly size: number;
  readonly modifiedAt: string;
}

/**
 * What an agent sees of a web page: its title and address, and an outline of
 * the page from its accessibility tree. Elements an agent can act on carry a
 * number in brackets, `[412] button "Sign in"`, which `click` and `type` take.
 */
export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly outline: string;
}

/**
 * One agent's browser (M3.04): a real Chromium with the agent's own profile,
 * driven through the accessibility tree rather than screenshots. Each method
 * returns the page as it is afterwards.
 */
export interface AgentBrowser {
  open(url: string): Promise<PageSnapshot>;
  snapshot(): Promise<PageSnapshot>;
  click(ref: number): Promise<PageSnapshot>;
  type(
    ref: number,
    text: string,
    options?: { clear?: boolean; submit?: boolean },
  ): Promise<PageSnapshot>;
  press(key: string): Promise<PageSnapshot>;
  back(): Promise<PageSnapshot>;
}

/**
 * One frame of an agent's browser as a person sees it (M3.07): a JPEG of the
 * page, and the page's size in CSS pixels, which input coordinates use.
 */
export interface ScreenFrame {
  /** Base64 JPEG. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

/** What a person does in a taken-over browser. Coordinates are CSS pixels of the page. */
export type ScreenInput =
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up" | "wheel";
      readonly x: number;
      readonly y: number;
      readonly button?: "left" | "middle" | "right";
      readonly clicks?: number;
      readonly deltaX?: number;
      readonly deltaY?: number;
      readonly modifiers?: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      readonly text?: string;
      readonly modifiers?: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "back" }
  | { readonly type: "reload" };

/**
 * A live view of an agent's browser (M3.07): streamed frames, and, for a
 * person who has taken over, their mouse and keyboard. Nothing is recorded:
 * frames go to the viewer and nowhere else.
 */
export interface ScreenSession {
  onFrame(listener: (frame: ScreenFrame) => void): void;
  /** Called once if the browser goes away. */
  onEnd(listener: (reason: string) => void): void;
  input(event: ScreenInput): Promise<void>;
  close(): void;
}

export interface SandboxHandle {
  readonly id: string;
  exec(
    agentId: AgentId,
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult>;
  /** Paths are relative to the shared workspace unless absolute. */
  readFile(agentId: AgentId, path: string): Promise<Uint8Array>;
  writeFile(agentId: AgentId, path: string, content: Uint8Array | string): Promise<void>;
  listFiles(agentId: AgentId, path: string): Promise<{ entries: FileEntry[]; truncated: boolean }>;
  browser(agentId: AgentId): Promise<AgentBrowser>;
  /**
   * Copy one site's cookies (its logins) from one agent's browser to
   * another's. Only on a person's explicit request (ADR-0010).
   */
  shareLogin(from: AgentId, to: AgentId, domain: string): Promise<{ cookies: number }>;
  /** Watch an agent's browser, starting it if needed (a person's view, M3.07). */
  screen(agentId: AgentId): Promise<ScreenSession>;
  /**
   * Hand the agent's browser to a person, or back (M3.07). While a person has
   * it, the agent's browser tools are refused and say why.
   */
  takeover(agentId: AgentId, on: boolean): Promise<void>;
  /** Stop what an agent is running (its browser and commands), or everyone's. */
  restart(agentId?: AgentId): Promise<void>;
  health(): Promise<{ ok: boolean; version?: string }>;
}

/** Why the computer could not do something; `message` is written for people and models. */
export class SandboxError extends Error {
  override readonly name = "SandboxError";
  constructor(
    readonly code:
      | "unavailable"
      | "bad_request"
      | "not_found"
      | "too_large"
      | "navigation_failed"
      | "taken_over"
      | "no_element"
      | "timeout",
    message: string,
  ) {
    super(message);
  }
}

export interface SandboxProvider {
  acquire(ctx: TenantContext): Promise<SandboxHandle>;
  /** Free what the user's computer holds in memory (browsers); files stay. */
  pause(ctx: TenantContext): Promise<void>;
  release(ctx: TenantContext): Promise<void>;
}
