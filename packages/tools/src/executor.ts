import {
  artifactUri,
  noopTelemetry,
  type AgentDirectory,
  type AgentProfile,
  type ArtifactStore,
  type PolicyEngine,
  type RunContext,
  type Telemetry,
  type ToolCallStore,
  type ToolExecutor,
  type ToolOutcome,
} from "@ofa/core";
import { grantFor, PLATFORM_TOOLS } from "@ofa/policy";
import { LOAD_TOOLKIT } from "./builtins/toolkits";
import { toDescriptor } from "./define";
import type {
  Toolkit,
  ToolDefinition,
  ToolkitSource,
  ToolkitSummary,
  ToolRegistry,
  ToolRunContext,
  ToolRunResult,
} from "./define";

// The tool executor (ARCHITECTURE.md §9.1, "Execution"): the one place a tool
// runs. In order: schema check, policy verdict, idempotency record, run with
// a timeout, redact, size-limit, record the result.

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly policy: PolicyEngine;
  readonly calls: ToolCallStore;
  readonly agents: AgentDirectory;
  /** Each workspace's connected apps and their tools (M4.05). */
  readonly toolkits?: ToolkitSource;
  /** Apps with more granted tools than this wait behind `load_toolkit`. Default 8. */
  readonly directToolkitLimit?: number;
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

/** Arguments shown on an approval card when a tool cannot say it better. */
function argsText(args: unknown): string {
  const text = JSON.stringify(args ?? {});
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/** Whether an agent may see a tool: granted and not blocked, or a platform tool. */
function visible(agent: AgentProfile, name: string): boolean {
  const grant = grantFor(agent.grants, name);
  return grant ? grant.mode !== "blocked" : PLATFORM_TOOLS.has(name);
}

/** The tool's editable arguments that this call fills with text (ADR-0030). */
function editableIn(
  tool: { editable?: readonly string[] },
  args: unknown,
): { editable?: string[] } {
  const values = (args ?? {}) as Record<string, unknown>;
  const editable = (tool.editable ?? []).filter((name) => typeof values[name] === "string");
  return editable.length > 0 ? { editable } : {};
}

/** The tool's own words for a call, or its name and arguments; never fails. */
async function describe(
  tool: { name: string; describe?: (args: unknown, ctx: ToolRunContext) => Promise<string> },
  args: unknown,
  ctx: ToolRunContext,
): Promise<string> {
  const plain = `${tool.name} ${argsText(args)}`;
  if (!tool.describe) return plain;
  try {
    const text = (await withTimeout(tool.describe(args, ctx), 10_000)).trim();
    return text ? text.slice(0, 1_000) : plain;
  } catch {
    return plain;
  }
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  const { registry, policy, calls } = options;
  const directLimit = options.directToolkitLimit ?? 8;

  /**
   * The workspace's toolkits, each cut down to what this agent was granted,
   * with the tools the run has loaded: a whole app, or the ones it picked.
   */
  async function grantedKits(
    ctx: RunContext,
    agent: AgentProfile,
    loaded: ReadonlySet<string>,
  ): Promise<
    { kit: Toolkit; summary: ToolkitSummary; inList: readonly ToolDefinition<unknown>[] }[]
  > {
    const kits = (await options.toolkits?.toolkits(ctx)) ?? [];
    return kits.flatMap((kit) => {
      // App tools need a grant: none of them is a platform tool.
      const tools = kit.tools.filter((t) => {
        const grant = grantFor(agent.grants, t.name);
        return grant !== undefined && grant.mode !== "blocked";
      });
      if (tools.length === 0) return [];
      const whole = loaded.has(kit.app) || tools.length <= directLimit;
      return [
        {
          kit: { ...kit, tools },
          summary: {
            app: kit.app,
            name: kit.name,
            description: kit.description,
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
            loaded: whole,
          },
          inList: whole ? tools : tools.filter((t) => loaded.has(t.name)),
        },
      ];
    });
  }

  /** The built-in registry plus this workspace's toolkits. */
  async function registryFor(ctx: RunContext): Promise<ToolRegistry> {
    const kits = (await options.toolkits?.toolkits(ctx)) ?? [];
    return kits.length ? registry.extend(kits.flatMap((k) => k.tools)) : registry;
  }
  const telemetry = options.telemetry ?? noopTelemetry;
  const maxChars = options.maxResultChars ?? 12_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? Date.now;
  const redact = options.redact ?? (async (_ctx: RunContext, text: string) => text);
  const store = options.artifacts;

  return {
    async listTools(ctx, listing = {}) {
      // The model only ever sees tools this agent was granted (§7: small tool lists).
      const agent = await options.agents.get(ctx, ctx.agentId);
      if (!agent) return [];
      const kits = await grantedKits(ctx, agent, new Set(listing.toolkits ?? []));
      const waiting = kits.filter((k) => !k.summary.loaded).map((k) => k.summary);
      // Tools that describe themselves per run (the agents a run can hand work to).
      const listed = new Map<string, { readonly description: string } | null>();
      for (const d of registry.descriptors()) {
        const tool = registry.get(d.name);
        if (tool?.listed && visible(agent, d.name)) listed.set(d.name, await tool.listed(ctx));
      }
      const builtins = registry.descriptors().flatMap((d) => {
        if (!visible(agent, d.name)) return [];
        if (listed.has(d.name)) {
          const own = listed.get(d.name);
          return own ? [{ ...d, description: own.description }] : [];
        }
        if (d.name !== LOAD_TOOLKIT) return [d];
        // Only when something is waiting, naming what is and its tools, so the
        // agent can pick from a large app in one call.
        if (waiting.length === 0) return [];
        const apps = waiting
          .map((s) => {
            const names = s.tools.map((t) => t.name.slice(s.app.length + 1)).join(", ");
            return `${s.app} (${s.name}, ${s.tools.length} tools: ${names}): ${s.description}`;
          })
          .join("\n");
        return [{ ...d, description: `${d.description}\nApps you can load:\n${apps}` }];
      });
      const loadedTools = kits.flatMap((k) => k.inList.map((t) => toDescriptor(t as never)));
      const all = [...builtins, ...loadedTools];
      // A proactive check sees only what can't change anything (M5.10).
      return listing.readOnly ? all.filter((t) => t.annotations.readOnly) : all;
    },

    async execute(request, ctx): Promise<ToolOutcome> {
      const started = now();
      const span = telemetry.startSpan(
        "tool.call",
        { "tool.name": request.name, "run.id": ctx.runId, "run.tainted": request.tainted },
        { trace: ctx.runId },
      );
      try {
        const tools = await registryFor(ctx);
        const tool = tools.get(request.name);
        if (!tool) {
          return {
            status: "error",
            code: "unknown_tool",
            message: `No tool named ${request.name}`,
            durationMs: 0,
          };
        }
        const descriptor = tools.descriptors().find((d) => d.name === request.name)!;

        // Before policy and before anything is recorded: a malformed call
        // goes back to the model to fix, and never reaches the tool (M2.29).
        const parsed = tools.validate(request.name, request.args);
        if (!parsed.ok) {
          return {
            status: "error",
            code: "invalid_args",
            // A validator can quote the value it refused.
            message: await redact(ctx, parsed.message),
            durationMs: 0,
          };
        }

        const agent = await options.agents.get(ctx, ctx.agentId);
        const runCtx: ToolRunContext = {
          ...ctx,
          idempotencyKey: request.idempotencyKey,
          tainted: request.tainted,
          memoryScopes: agent?.memoryScopes ?? [],
          ...(options.toolkits && agent
            ? {
                toolkits: {
                  list: async () =>
                    (await grantedKits(ctx, agent, new Set())).map((k) => k.summary),
                },
              }
            : {}),
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

        // The site the call acts on: only taint escalation looks at it, so
        // only a tainted run asks the tool.
        const site =
          request.tainted && tool.site
            ? ((await withTimeout(tool.site(parsed.value, runCtx), 10_000).catch(() => null)) ??
              undefined)
            : undefined;

        const decision = await policy.evaluate({
          ctx,
          tool: descriptor,
          args: parsed.value,
          tainted: request.tainted,
          knownUrls: new Set(request.knownUrls ?? []),
          ...(site ? { site } : {}),
          allowedSites: new Set(request.allowedSites ?? []),
          ...(request.readOnly ? { readOnly: true } : {}),
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

        if (decision.verdict !== "auto" && !request.approved) {
          // A person must agree first (§6.2): nothing runs; the harness asks
          // them, showing what the call would do, and calls again if they agree.
          return {
            status: "blocked",
            verdict: decision.verdict,
            reasons: decision.reasons,
            message: `${request.name} needs a person's approval first.`,
            summary: await redact(ctx, await describe(tool, parsed.value, runCtx)),
            ...(decision.allowSite ? { allowSite: decision.allowSite } : {}),
            ...editableIn(tool, parsed.value),
            ...(tool.showArgs ? { showArgs: true } : {}),
          };
        }

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
