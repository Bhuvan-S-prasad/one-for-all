import { useAppTools, useMcpServers } from "@ofa/client";
import type { AgentGrant, AppTool, McpServer } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { AppIcon } from "@/components/app-icon";
import { cn } from "@/lib/utils";

// Which connected apps an agent may use, and how (M4.09). A whole app
// (`notion.*`) either runs reads by itself and asks before changes, or asks
// every time; single tools can be set apart from that. Grants decide what an
// agent may try; policy still asks for anything that can't be undone, and
// after outside content (§10.2).

type AppMode = "off" | "auto" | "approve";
type ToolMode = "app" | "auto" | "approve" | "blocked";

const APP_MODES: { value: AppMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Only the tools you pick below" },
  {
    value: "auto",
    label: "Reads run, changes ask",
    hint: "It reads by itself and asks before changing anything",
  },
  { value: "approve", label: "Ask every time", hint: "Every use waits for you" },
];

function appMode(grants: readonly AgentGrant[], slug: string): AppMode {
  const grant = grants.find((g) => g.tool === `${slug}.*`);
  return grant?.mode === "auto" ? "auto" : grant?.mode === "approve" ? "approve" : "off";
}

/** Set one grant (`tool`), or remove it with `null`. */
function withGrant(
  grants: readonly AgentGrant[],
  tool: string,
  mode: AgentGrant["mode"] | null,
): AgentGrant[] {
  const rest = grants.filter((g) => g.tool !== tool);
  return mode ? [...rest, { tool, mode }] : rest;
}

export function AppGrants({
  grants,
  onChange,
  agentName,
}: {
  /** The agent's grants that aren't built-in tools. */
  grants: readonly AgentGrant[];
  onChange: (grants: AgentGrant[]) => void;
  agentName: string;
}) {
  const { data: servers, isPending } = useMcpServers();
  const apps = (servers ?? []).filter((s) => s.enabled && (s.toolCount ?? 0) > 0);

  if (isPending) return <div className="skeleton h-20 w-full rounded-md" />;
  if (apps.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
        No apps yet.{" "}
        <Link to="/connections" className="font-semibold text-foreground underline">
          Connect one
        </Link>{" "}
        (Notion, Gmail, GitHub…) and it shows up here for {agentName} to use.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {apps.map((server) => (
        <AppRow key={server.id} server={server} grants={grants} onChange={onChange} />
      ))}
    </ul>
  );
}

function AppRow({
  server,
  grants,
  onChange,
}: {
  server: McpServer;
  grants: readonly AgentGrant[];
  onChange: (grants: AgentGrant[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const mode = appMode(grants, server.slug);
  const picked = grants.filter(
    (g) => g.tool.startsWith(`${server.slug}.`) && g.tool !== `${server.slug}.*`,
  );
  const signedIn = server.connection?.status === "active";

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <AppIcon id={server.catalogId} name={server.name} className="size-9 rounded-[11px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold">{server.name}</span>
          <span className="text-sm text-muted-foreground">
            {server.toolCount} tools
            {picked.length > 0 && ` · ${picked.length} set apart`}
            {!signedIn && " · runs need the person’s own sign-in on Connections"}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label={`${server.name}: how ${server.slug} may be used`}
          className="flex flex-wrap gap-1 rounded-full border p-1"
        >
          {APP_MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              title={option.hint}
              onClick={() =>
                onChange(
                  withGrant(
                    grants,
                    `${server.slug}.*`,
                    option.value === "off" ? null : option.value,
                  ),
                )
              }
              className={cn(
                "h-8 rounded-full px-3 text-[12.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mode === option.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 self-start text-[13px] font-semibold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn("size-4 transition-transform", open && "rotate-180")}
          aria-hidden
        />
        Choose single tools
      </button>
      {open && <ToolList server={server} grants={grants} onChange={onChange} appMode={mode} />}
    </li>
  );
}

const TOOL_MODES: { value: ToolMode; label: string }[] = [
  { value: "app", label: "Like the app" },
  { value: "auto", label: "Run without asking" },
  { value: "approve", label: "Ask first" },
  { value: "blocked", label: "Never" },
];

/** What a tool does to the app, in a word; never colour alone. */
function kindOf(tool: AppTool): string {
  if (tool.readOnly) return "Reads";
  return tool.destructive ? "Changes · may not be undoable" : "Changes";
}

function ToolList({
  server,
  grants,
  onChange,
  appMode: whole,
}: {
  server: McpServer;
  grants: readonly AgentGrant[];
  onChange: (grants: AgentGrant[]) => void;
  appMode: AppMode;
}) {
  const { data: tools, error, isPending } = useAppTools(server.id);
  if (isPending) return <div className="skeleton h-24 w-full rounded-md" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  /** What "Like the app" means for this tool right now. */
  const inherited = (tool: AppTool) =>
    whole === "off" ? "not allowed" : whole === "approve" || !tool.readOnly ? "asks first" : "runs";

  return (
    <ul className="flex max-h-96 flex-col divide-y overflow-auto rounded-md border bg-background/50">
      {(tools ?? []).map((tool) => {
        const grant = grants.find((g) => g.tool === tool.name);
        const value: ToolMode = grant?.mode ?? "app";
        const id = `grant-${tool.name}`;
        return (
          <li key={tool.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <label htmlFor={id} className="font-mono text-[12.5px] font-semibold">
                {tool.name}
              </label>
              <span className="line-clamp-2 text-[12.5px] text-muted-foreground">
                <span className="eyebrow mr-1.5 text-[10px] text-foreground">{kindOf(tool)}</span>
                {tool.description}
              </span>
            </div>
            <select
              id={id}
              value={value}
              onChange={(e) => {
                const next = e.target.value as ToolMode;
                onChange(withGrant(grants, tool.name, next === "app" ? null : next));
              }}
              className="h-9 rounded-md border border-input bg-field px-2.5 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            >
              {TOOL_MODES.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  // Policy asks for these anyway: don't offer what wouldn't happen.
                  disabled={option.value === "auto" && tool.destructive}
                >
                  {option.value === "app" ? `Like the app (${inherited(tool)})` : option.label}
                  {option.value === "auto" && tool.destructive ? " (always asks)" : ""}
                </option>
              ))}
            </select>
          </li>
        );
      })}
    </ul>
  );
}
