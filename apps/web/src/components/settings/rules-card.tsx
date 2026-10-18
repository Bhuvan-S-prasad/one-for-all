import {
  ApiError,
  useAgents,
  useCreatePolicyRule,
  useDeletePolicyRule,
  useMcpServers,
  usePolicyRules,
  useSetPolicyRuleEnabled,
} from "@ofa/client";
import type { PolicyRuleItem } from "@ofa/contracts";
import { useState, type FormEvent } from "react";
import { Select } from "@/components/ui/select";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BUILTIN_TOOLS } from "@/lib/agents";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Rules (ARCHITECTURE.md §10.2, M4.09): "ask first" makes a tool wait for a
// person even where an agent may use it freely; "allow without asking" lets
// it run where it would otherwise ask. Owners and admins set the workspace's
// rules; anyone can add rules for their own runs, which only ask first.

/** "*", "notion.*", "gmail.send_draft" in words. */
function toolWords(tool: string): string {
  if (tool === "*") return "Every tool";
  if (tool.endsWith(".*")) return `Every ${tool.slice(0, -2)} tool`;
  return tool;
}

export function RulesCard({ canEditWorkspace }: { canEditWorkspace: boolean }) {
  const { data: rules, error } = usePolicyRules();
  const { data: agents } = useAgents();
  const { data: servers } = useMcpServers();
  const create = useCreatePolicyRule();
  const setEnabled = useSetPolicyRuleEnabled();
  const remove = useDeletePolicyRule();

  const [tool, setTool] = useState("");
  const [effect, setEffect] = useState<"ask_first" | "allow_auto">("ask_first");
  const [scope, setScope] = useState<"workspace" | "personal">(
    canEditWorkspace ? "workspace" : "personal",
  );
  const [agentId, setAgentId] = useState("");
  const [description, setDescription] = useState("");

  const suggestions = [
    "*",
    ...(servers ?? []).map((s) => `${s.slug}.*`),
    ...BUILTIN_TOOLS.map((t) => t.name),
  ];
  const agentName = (id: string | null) =>
    id ? (agents?.find((a) => a.id === id)?.name ?? "One agent") : "All agents";
  const mayChange = (rule: PolicyRuleItem) => rule.scope === "personal" || canEditWorkspace;
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors() : {};

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!tool.trim()) return;
    create.mutate(
      {
        tool: tool.trim(),
        effect: scope === "personal" ? "ask_first" : effect,
        scope,
        agentId: agentId || null,
        description: description.trim(),
      },
      {
        onSuccess: (rule) => {
          setTool("");
          setDescription("");
          toast(
            `Added: ${toolWords(rule.tool)} ${rule.effect === "ask_first" ? "asks first" : "runs without asking"}`,
          );
        },
      },
    );
  };

  return (
    <Card className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <CardTitle>Rules</CardTitle>
        <p className="text-sm text-muted-foreground">
          <b className="font-semibold text-foreground">Ask first</b> makes a tool wait for you, even
          where an agent may use it freely.{" "}
          <b className="font-semibold text-foreground">Allow without asking</b> lets it run where it
          would otherwise ask, but never for payments, deletions and other things that always need a
          person, never after outside content, and never over an ask-first rule.
        </p>
      </div>
      {error && <ErrorAlert>{error.message}</ErrorAlert>}
      {rules && rules.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
              <div
                className={cn(
                  "flex min-w-0 flex-1 flex-col gap-0.5",
                  !rule.enabled && "opacity-60",
                )}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold">{rule.tool}</span>
                  <span
                    className={cn(
                      "eyebrow rounded-full px-2 py-0.5 text-[10.5px]",
                      rule.effect === "ask_first"
                        ? "bg-warning/15 text-foreground"
                        : "bg-primary/15 text-foreground",
                    )}
                  >
                    {rule.effect === "ask_first" ? "Asks first" : "Runs without asking"}
                  </span>
                </span>
                <span className="text-sm text-muted-foreground">
                  {agentName(rule.agentId)} ·{" "}
                  {rule.scope === "workspace" ? "everyone’s runs" : "only your runs"}
                  {rule.description ? ` · ${rule.description}` : ""}
                </span>
              </div>
              {mayChange(rule) && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={`Rule for ${rule.tool}`}
                    disabled={setEnabled.isPending}
                    onClick={() =>
                      setEnabled.mutate(
                        { id: rule.id, enabled: !rule.enabled },
                        { onError: (e) => toast({ message: e.message, tone: "error" }) },
                      )
                    }
                    className={cn(
                      "eyebrow h-8 w-14 shrink-0 rounded-full text-[10.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      rule.enabled
                        ? "bg-primary text-primary-foreground"
                        : "border text-muted-foreground",
                    )}
                  >
                    {rule.enabled ? "On" : "Off"}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(rule.id, {
                        onSuccess: () => toast(`Removed the rule for ${rule.tool}`),
                        onError: (e) => toast({ message: e.message, tone: "error" }),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {rules && rules.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No rules yet. Each agent uses what you allowed in its settings.
        </p>
      )}
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-tool">When an agent uses</Label>
          <Input
            id="rule-tool"
            list="rule-tools"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            placeholder="gmail.* or web.search"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={fieldErrors.tool ? "rule-tool-error" : undefined}
          />
          <datalist id="rule-tools">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          {fieldErrors.tool && (
            <p id="rule-tool-error" className="text-sm text-destructive">
              {fieldErrors.tool}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-effect">Then</Label>
          <Select
            id="rule-effect"
            value={scope === "personal" ? "ask_first" : effect}
            onChange={(e) => setEffect(e.target.value as typeof effect)}
          >
            <option value="ask_first">Ask first</option>
            {scope === "workspace" && <option value="allow_auto">Allow without asking</option>}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-agent">For</Label>
          <Select id="rule-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {(agents ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rule-scope">In</Label>
          <Select
            id="rule-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            {canEditWorkspace && <option value="workspace">Everyone’s runs</option>}
            <option value="personal">Only my runs (can only ask first)</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="rule-why">Why (optional)</Label>
          <Input
            id="rule-why"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Shown on the approval card"
            maxLength={500}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={create.isPending || !tool.trim()}>
            Add rule
          </Button>
          <span className="text-sm text-muted-foreground">
            Use * for every tool, gmail.* for every tool of an app.
          </span>
        </div>
        {create.error && !fieldErrors.tool && (
          <div className="sm:col-span-2">
            <ErrorAlert>{create.error.message}</ErrorAlert>
          </div>
        )}
      </form>
    </Card>
  );
}
