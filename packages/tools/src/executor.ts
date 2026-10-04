import {
  artifactUri,
  noopTelemetry,
  type AgentDirectory,
  type ArtifactStore,
  type PolicyEngine,
  type RunContext,
  type Telemetry,
  type ToolCallStore,
  type ToolExecutor,
  type ToolOutcome,
} from "@ofa/core";
import { grantFor, PLATFORM_TOOLS } from "@ofa/policy";
import type { ToolRegistry, ToolRunContext, ToolRunResult } from "./define";

// The tool executor (ARCHITECTURE.md §9.1, "Execution"): the one place a tool
// runs. In order: schema check, policy verdict, idempotency record, run with
// a timeout, redact, size-limit, record the result.

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly policy: PolicyEngine;
  readonly calls: ToolCallStore;
  readonly agents: AgentDirectory;
  /** Replace known secret values in output (vault redaction). */
  readonly redact?: (ctx: RunContext, text: string) => Promise<string>;
  readonly telemetry?: Telemetry;
  /**
   * Longest output the model sees. Default 12,000 characters. Longer output
   * is kept as an artifact the agent can reopen, when `artifacts` is set.
   */
  readonly maxResultChars?: number;
  readonly artifacts?: ArtifactStore;
  /** Saved logins, decrypted only when a tool asks for one (M3.08, ADR-0012). */
  readonly logins?: (
    ctx: RunContext,
    site: string,
  ) => Promise<{ readonly username: string; readonly password: string } | null>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

function asText(content: ToolRunResult["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function limit(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[cut: ${text.length - max} more characters]`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`Timed out after ${ms} ms`), { code: "timeout" })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  const { registry, policy, calls } = options;
  const telemetry = options.telemetry ?? noopTelemetry;
  const maxChars = options.maxResultChars ?? 12_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? Date.now;
  const redact = options.redact ?? (async (_ctx: RunContext, text: string) => text);
  const store = options.artifacts;

  return {
    async listTools(ctx) {
      // The model only ever sees tools this agent was granted (§7: small tool lists).
      const agent = await options.agents.get(ctx, ctx.agentId);
      if (!agent) return [];
      return registry.descriptors().filter((d) => {
        const grant = grantFor(agent.grants, d.name);
        if (grant) return grant.mode !== "blocked";
        return PLATFORM_TOOLS.has(d.name);
      });
    },

    async execute(request, ctx): Promise<ToolOutcome> {
      const started = now();
      const span = telemetry.startSpan(
        "tool.call",
        { "tool.name": request.name, "run.id": ctx.runId, "run.tainted": request.tainted },
        { trace: ctx.runId },
      );
      try {
        const tool = registry.get(request.name);
        if (!tool) {
          return {
            status: "error",
            code: "unknown_tool",
            message: `No tool named ${request.name}`,
            durationMs: 0,
          };
        }
        const descriptor = registry.descriptors().find((d) => d.name === request.name)!;

        // Before policy and before anything is recorded: a malformed call
        // goes back to the model to fix, and never reaches the tool (M2.29).
        const parsed = registry.validate(request.name, request.args);
        if (!parsed.ok) {
          return { status: "error", code: "invalid_args", message: parsed.message, durationMs: 0 };
        }

        const decision = await policy.evaluate({
          ctx,
          tool: descriptor,
          args: parsed.value,
          tainted: request.tainted,
        });
        span.setAttributes({ "policy.verdict": decision.verdict });
        if (decision.verdict === "deny") {
          return {
            status: "blocked",
            verdict: "deny",
            reasons: decision.reasons,
            message: decision.reasons[0] ?? "Not allowed",
          };
        }
        if (decision.verdict !== "auto") {
          // Approval cards arrive in M4; until then, anything that needs a
          // person does not run.
          return {
            status: "blocked",
            verdict: decision.verdict,
            reasons: decision.reasons,
            message: `${request.name} needs a person's approval first, and approvals are not available yet.`,
          };
        }

        const agent = await options.agents.get(ctx, ctx.agentId);
        const runCtx: ToolRunContext = {
          ...ctx,
          idempotencyKey: request.idempotencyKey,
          tainted: request.tainted,
          memoryScopes: agent?.memoryScopes ?? [],
          ...(options.logins
            ? { logins: { get: (site: string) => options.logins!(ctx, site) } }
            : {}),
          ...(store
            ? {
                artifacts: {
                  put: (input) => store.put(ctx, input),
                  // An agent reopens only its own artifacts.
                  get: async (id) => {
                    const found = await store.get(ctx, id);
                    return found && found.agentId === ctx.agentId ? found : null;
                  },
                  read: async (id) => {
                    const found = await store.get(ctx, id);
                    return found && found.agentId === ctx.agentId ? store.read(ctx, id) : null;
                  },
                },
              }
            : {}),
        };
        const idempotent = !!(tool.annotations.readOnly || tool.annotations.idempotent);
        const begun = await calls.begin(ctx, {
          idempotencyKey: request.idempotencyKey,
          tool: request.name,
          args: JSON.parse(await redact(ctx, JSON.stringify(parsed.value ?? {}))),
          verdict: decision.verdict,
        });

        let result: ToolRunResult | null = null;
        if (!begun.created) {
          const existing = begun.existing;
          if (existing.status === "done") {
            // Already ran: hand back what it returned (ADR-0015).
            return {
              status: "ok",
              content: String(existing.result ?? ""),
              untrusted: existing.untrusted,
              verdict: decision.verdict,
              reasons: decision.reasons,
              durationMs: 0,
            };
          }
          if (tool.verify) {
            result = await tool.verify(parsed.value, runCtx);
          } else if (!idempotent) {
            return {
              status: "error",
              code: "uncertain",
              message: `${request.name} may already have run before a crash; not repeating it.`,
              verdict: decision.verdict,
              reasons: decision.reasons,
              durationMs: 0,
            };
          }
        }

        try {
          result ??= await withTimeout(tool.run(parsed.value, runCtx), timeoutMs);
        } catch (error) {
          const code = (error as { code?: string }).code ?? "tool_failed";
          const message = await redact(ctx, error instanceof Error ? error.message : String(error));
          await calls.fail(ctx, request.idempotencyKey, { code, message });
          span.recordError(error);
          return {
            status: "error",
            code,
            message,
            verdict: decision.verdict,
            reasons: decision.reasons,
            durationMs: now() - started,
          };
        }

        const full = await redact(ctx, asText(result.content));
        let content = limit(full, maxChars);
        let artifactId = result.artifactId;
        if (full.length > maxChars && store) {
          // Too long for the context: keep it whole, show the start and the handle (§7).
          const saved = await store.put(ctx, {
            key: `${request.idempotencyKey}:output`,
            kind: "output",
            name: `${request.name} output`,
            mimeType: "text/plain; charset=utf-8",
            content: full,
            untrusted: result.untrusted,
          });
          artifactId ??= saved.id;
          const head = Math.max(0, maxChars - 300);
          content = `${full.slice(0, head)}\n…[the full output, ${full.length.toLocaleString("en")} characters, is saved as ${artifactUri(saved.id)}; read on with artifacts.read and from: ${head}]`;
        }
        await calls.complete(ctx, request.idempotencyKey, {
          result: content,
          untrusted: result.untrusted,
        });
        return {
          status: "ok",
          content,
          untrusted: result.untrusted,
          ...(artifactId ? { artifactId } : {}),
          verdict: decision.verdict,
          reasons: decision.reasons,
          durationMs: now() - started,
        };
      } finally {
        span.end();
      }
    },
  };
}
