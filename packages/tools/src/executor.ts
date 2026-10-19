import {
  artifactUri,
  noopTelemetry,
  toCents,
  type AgentCapability,
  type AgentDirectory,
  type AgentProfile,
  type ArtifactStore,
  type PolicyEngine,
  type RunContext,
  type SpendLedger,
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
  /** Files people attached, opened only for a run of their own chat (EN.09). */
  readonly uploads?: (
    ctx: RunContext,
    id: string,
  ) => Promise<{
    readonly name: string;
    readonly mimeType: string;
    readonly size: number;
    readonly body: AsyncIterable<Uint8Array>;
  } | null>;
  /** Saved logins, decrypted only when a tool asks for one (M3.08, ADR-0012). */
  readonly logins?: (
    ctx: RunContext,
    site: string,
  ) => Promise<{ readonly username: string; readonly password: string } | null>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /**
   * Paid app credits (EN.15): a call with a cost estimate is refused when it
   * would pass the workspace's monthly cap, and counted when it starts.
   */
  readonly spend?: SpendLedger;
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

// Capability cards (ADR-0044): what an agent can do, in a few plain words per
// area, for the team roster. Tools every agent has are left out.

const NOT_A_CAPABILITY = new Set([
  "artifacts.read",
  "load_toolkit",
  "todo.write",
  "remember",
  "recall",
  "run_skill",
  "save_skill",
  "remind_me",
  "schedule_task",
  "delegate_task",
  "message_agent",
]);

const AREAS: Record<string, string> = {
  web: "web",
  browser: "browser",
  use_saved_login: "browser",
  shell: "terminal",
  files: "files",
  desktop: "desktop apps",
  video: "video",
};

/** Built-in tools in a word or two; null folds a tool into its area's others. */
const ABILITIES: Record<string, string | null> = {
  "web.search": "search",
  "web.read_url": "read pages",
  "browser.open": "open websites",
  "browser.click": "click",
  "browser.type": "fill in forms",
  "browser.snapshot": null,
  "browser.press": null,
  "browser.back": null,
  use_saved_login: "sign in with saved logins",
  "shell.run": "run commands and Python",
  "files.read": "read",
  "files.write": "write",
  "files.list": null,
  "files.send": "send files to the person",
  "desktop.open": "open files in apps (Word, Excel, text)",
  "desktop.click": "click",
  "desktop.type": "type",
  "desktop.snapshot": null,
  "desktop.press": null,
  "desktop.screenshot": null,
  "desktop.click_at": null,
  "desktop.type_text": null,
  "video.scan": "read footage",
  "video.music": null,
  "video.cut_to_music": "cut videos to music",
  "video.transcribe": "transcribe speech",
  "video.plan_beats": null,
  "video.render": "edit and render",
  "video.verify": null,
  "video.contact_sheet": null,
  "video.styles": null,
};

/** Abilities shown per app; the rest are counted. */
const ABILITIES_PER_AREA = 8;

/** A tool's action in words: `gmail.create_draft` → `create draft`. */
function actionWords(name: string): string {
  const dot = name.indexOf(".");
  return (dot >= 0 ? name.slice(dot + 1) : name).replaceAll("_", " ");
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
    async capabilities(ctx, agentIds) {
      const kits = (await options.toolkits?.toolkits(ctx)) ?? [];
      const cards = new Map<string, AgentCapability[]>();
      for (const agentId of agentIds) {
        const agent = await options.agents.get(ctx, agentId);
        if (!agent) continue;
        const areas = new Map<string, { abilities: string[]; tools: string[] }>();
        const add = (area: string, tool: string, ability: string | null, asks: boolean) => {
          const entry = areas.get(area) ?? { abilities: [], tools: [] };
          entry.tools.push(tool);
          const words = ability && (asks ? `${ability} (asks first)` : ability);
          if (words && !entry.abilities.includes(words)) entry.abilities.push(words);
          areas.set(area, entry);
        };
        for (const d of registry.descriptors()) {
          if (NOT_A_CAPABILITY.has(d.name) || PLATFORM_TOOLS.has(d.name)) continue;
          const grant = grantFor(agent.grants, d.name);
          if (!grant || grant.mode === "blocked") continue;
          const prefix = d.name.includes(".") ? d.name.slice(0, d.name.indexOf(".")) : d.name;
          const ability = d.name in ABILITIES ? (ABILITIES[d.name] ?? null) : actionWords(d.name);
          add(AREAS[prefix] ?? prefix, d.name, ability, grant.mode === "approve");
        }
        for (const kit of kits) {
          for (const tool of kit.tools) {
            const grant = grantFor(agent.grants, tool.name);
            if (!grant || grant.mode === "blocked") continue;
            add(kit.name, tool.name, actionWords(tool.name), grant.mode === "approve");
          }
        }
        cards.set(
          agentId,
          // An area of folded tools alone says nothing new, but its tools still count.
          [...areas]
            .filter(([, { abilities }]) => abilities.length > 0)
            .map(([area, { abilities, tools }]) => ({
              area,
              abilities:
                abilities.length > ABILITIES_PER_AREA
                  ? [
                      ...abilities.slice(0, ABILITIES_PER_AREA),
                      `${abilities.length - ABILITIES_PER_AREA} more`,
                    ]
                  : abilities,
              tools,
            })),
        );
      }
      return cards;
    },

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
          ...(options.uploads
            ? { uploads: { open: (id: string) => options.uploads!(ctx, id) } }
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

        // Paid credits (EN.15): refuse before asking anyone, so nobody
        // approves a call that the monthly cap would stop anyway.
        const costCents = options.spend ? toCents(tool.annotations.costUsd ?? 0) : 0;
        if (costCents > 0) {
          const { spentCents, capCents } = await options.spend!.month(ctx);
          if (capCents !== null && spentCents + costCents > capCents) {
            const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
            const reason = `this month's limit for paid app credits is ${usd(capCents)}, and ${usd(spentCents)} is used; this call would cost about ${usd(costCents)}`;
            return {
              status: "blocked",
              verdict: "deny",
              reasons: [...decision.reasons, reason],
              message: `Not run: ${reason}. A workspace owner can raise the limit in Settings.`,
            };
          }
        }

        if (decision.verdict !== "auto" && !request.approved) {
          // A person must agree first (§6.2): nothing runs; the harness asks
          // them, showing what the call would do, and calls again if they agree.
          // The card lists every argument in full (showArgs): a summary can be
          // cut short, and what the person approves must be what runs.
          return {
            status: "blocked",
            verdict: decision.verdict,
            reasons: decision.reasons,
            message: `${request.name} needs a person's approval first.`,
            summary: await redact(ctx, await describe(tool, parsed.value, runCtx)),
            ...(decision.allowSite ? { allowSite: decision.allowSite } : {}),
            ...editableIn(tool, parsed.value),
            showArgs: true,
          };
        }

        const idempotent = !!(tool.annotations.readOnly || tool.annotations.idempotent);
        const begun = await calls.begin(ctx, {
          idempotencyKey: request.idempotencyKey,
          tool: request.name,
          args: JSON.parse(await redact(ctx, JSON.stringify(parsed.value ?? {}))),
          verdict: decision.verdict,
        });

        // Counted when it starts: a provider may charge for a job that fails.
        if (costCents > 0) {
          await options.spend!.record(ctx, {
            idempotencyKey: request.idempotencyKey,
            tool: request.name,
            costCents,
          });
        }

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
          result ??= await withTimeout(
            tool.run(parsed.value, runCtx),
            Math.max(timeoutMs, tool.timeoutMs ?? 0),
          );
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
        if (result.image && store) {
          // A screenshot the model sees once is kept for people with the run (DT.11).
          const shot = await store.put(ctx, {
            key: `${request.idempotencyKey}:image`,
            kind: "output",
            name: "Screenshot",
            mimeType: result.image.mediaType,
            content: Buffer.from(result.image.data, "base64"),
            untrusted: result.untrusted,
          });
          artifactId ??= shot.id;
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
          ...(result.image ? { image: result.image } : {}),
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
