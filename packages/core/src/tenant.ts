import { TenantRequiredError } from "./errors";
import type { AgentId, RunId, UserId, WorkspaceId } from "./ids";

/**
 * Passed through every call (ADR-0001). Repository functions refuse to run
 * without one, and it sets the row-level-security session variable.
 */
export interface TenantContext {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly agentId?: AgentId;
  readonly runId?: RunId;
}

/** Context inside an agent run, where agent and run are always known. */
export interface RunContext extends TenantContext {
  readonly agentId: AgentId;
  readonly runId: RunId;
}

export function assertTenant(ctx: TenantContext | null | undefined): asserts ctx is TenantContext {
  if (!ctx || !ctx.workspaceId || !ctx.userId) {
    throw new TenantRequiredError();
  }
}

export function withRun(ctx: TenantContext, agentId: AgentId, runId: RunId): RunContext {
  return { ...ctx, agentId, runId };
}
