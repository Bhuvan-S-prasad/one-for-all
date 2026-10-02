import type {
  AgentProfile,
  LLMRequest,
  LLMResponse,
  RunContext,
  ToolExecutionRequest,
  ToolOutcome,
} from "@ofa/core";
import type { RunStopReason } from "@ofa/contracts";

// Harness middleware (ARCHITECTURE.md §6.2): onion-style hooks that behave
// the same for every agent. Each hook runs inside the durable step it belongs
// to, so anything it does is retried and memoized with that step.
//
// The run log is not a middleware: the harness writes it directly, so no
// configuration can turn it off (hard rule 7).

export interface RunHookContext {
  readonly ctx: RunContext;
  readonly agent: AgentProfile;
}

export interface RunEndInfo {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly stopReason: RunStopReason;
}

export interface HarnessMiddleware {
  readonly name: string;
  onRunStart?(run: RunHookContext): Promise<void>;
  /** Wraps a model call. Call `next` to continue; return its response (or a changed one). */
  aroundModel?(
    run: RunHookContext,
    request: LLMRequest,
    next: (request: LLMRequest) => Promise<LLMResponse>,
  ): Promise<LLMResponse>;
  /** Before a tool runs. Return an outcome to stop it running, or call `next`. */
  preTool?(
    run: RunHookContext,
    request: ToolExecutionRequest,
    next: (request: ToolExecutionRequest) => Promise<ToolOutcome>,
  ): Promise<ToolOutcome>;
  /** After a tool ran (or was blocked). May change what the model sees. */
  postTool?(
    run: RunHookContext,
    request: ToolExecutionRequest,
    outcome: ToolOutcome,
  ): Promise<ToolOutcome>;
  onRunEnd?(run: RunHookContext, info: RunEndInfo): Promise<void>;
  /** A step failed. Best effort: it may be retried and this may fire again. */
  onError?(run: RunHookContext | null, error: unknown): Promise<void>;
}

/** Compose wrap-style hooks: the first middleware is the outermost layer. */
function onion<Req, Res>(
  layers: readonly ((req: Req, next: (req: Req) => Promise<Res>) => Promise<Res>)[],
  core: (req: Req) => Promise<Res>,
): (req: Req) => Promise<Res> {
  return layers.reduceRight<(req: Req) => Promise<Res>>(
    (next, layer) => (req) => layer(req, next),
    core,
  );
}

export class MiddlewareChain {
  constructor(private readonly layers: readonly HarnessMiddleware[]) {}

  async runStart(run: RunHookContext): Promise<void> {
    for (const m of this.layers) await m.onRunStart?.(run);
  }

  model(run: RunHookContext, core: (r: LLMRequest) => Promise<LLMResponse>) {
    return onion(
      this.layers.flatMap((m) =>
        m.aroundModel ? [(r: LLMRequest, next: typeof core) => m.aroundModel!(run, r, next)] : [],
      ),
      core,
    );
  }

  tool(run: RunHookContext, core: (r: ToolExecutionRequest) => Promise<ToolOutcome>) {
    const wrapped = onion(
      this.layers.flatMap((m) =>
        m.preTool ? [(r: ToolExecutionRequest, next: typeof core) => m.preTool!(run, r, next)] : [],
      ),
      core,
    );
    return async (request: ToolExecutionRequest) => {
      let outcome = await wrapped(request);
      for (const m of this.layers)
        if (m.postTool) outcome = await m.postTool(run, request, outcome);
      return outcome;
    };
  }

  async runEnd(run: RunHookContext, info: RunEndInfo): Promise<void> {
    for (const m of this.layers) await m.onRunEnd?.(run, info);
  }

  async error(run: RunHookContext | null, error: unknown): Promise<void> {
    for (const m of this.layers) await m.onError?.(run, error).catch(() => {});
  }
}
