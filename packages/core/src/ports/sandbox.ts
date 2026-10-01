import type { AgentId } from "../ids";
import type { TenantContext } from "../tenant";

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One user's computer (ADR-0009). Each agent gets its own browser profile (ADR-0010). */
export interface SandboxHandle {
  readonly id: string;
  exec(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  /** Chrome DevTools Protocol endpoint for this agent's browser profile. */
  browserEndpoint(agentId: AgentId): Promise<string>;
  /** URL for watching and taking over the screen. */
  vncUrl(): Promise<string>;
}

export interface SandboxProvider {
  acquire(ctx: TenantContext): Promise<SandboxHandle>;
  pause(ctx: TenantContext): Promise<void>;
  release(ctx: TenantContext): Promise<void>;
}
