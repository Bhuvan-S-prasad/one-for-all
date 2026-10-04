import { useMemories } from "@ofa/client";
import type { Agent } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Familiar } from "@/components/familiar";
import { cn } from "@/lib/utils";

// The agent screen's tabs (UX.05, UX.13, UX.14): Chat, History, Memory,
// Activity and Settings, the same everywhere on the agent screen.

export type AgentTab = "chat" | "history" | "memory";

const TAB =
  "flex h-16 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-0.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground";
const CURRENT = "border-primary font-semibold text-foreground";

/** Facts waiting for the person to confirm them, for the Memory tab's badge. */
export function useUnconfirmedCount(agentId: string): number {
  const { data } = useMemories({ agentId, verified: false });
  return data?.length ?? 0;
}

export function AgentTabs({
  agent,
  current,
  className,
}: {
  agent: Agent;
  current: AgentTab;
  className?: string;
}) {
  const unconfirmed = useUnconfirmedCount(agent.id);
  const params = { agentId: agent.id };
  const tab = (name: AgentTab) => cn(TAB, current === name && CURRENT);
  const here = (name: AgentTab) => (current === name ? ("page" as const) : undefined);
  return (
    <nav aria-label={agent.name} className={cn("flex h-16 items-center gap-5", className)}>
      <Link
        to="/agents/$agentId"
        params={params}
        search={{}}
        aria-current={here("chat")}
        className={tab("chat")}
      >
        Chat
      </Link>
      <Link
        to="/agents/$agentId/history"
        params={params}
        aria-current={here("history")}
        className={tab("history")}
      >
        History
      </Link>
      <Link
        to="/agents/$agentId/memory"
        params={params}
        aria-current={here("memory")}
        className={tab("memory")}
      >
        Memory
        {unconfirmed > 0 && (
          <span className="eyebrow rounded-full bg-primary px-1.5 py-px text-[10px] text-primary-foreground">
            {unconfirmed} new
          </span>
        )}
      </Link>
      <Link to="/activity" search={{ agent: agent.id }} className={TAB}>
        Activity
      </Link>
      <Link to="/agents/$agentId/edit" params={params} className={TAB}>
        Settings
      </Link>
    </nav>
  );
}

/**
 * The header of the agent's other tabs (History, Memory): the familiar and
 * name, the tabs, and room for one action. Tabs scroll sideways on phones.
 */
export function AgentPageHeader({
  agent,
  current,
  action,
}: {
  agent: Agent;
  current: AgentTab;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-col border-b md:h-16 md:flex-row md:items-center md:gap-5 md:px-6">
      <div className="flex h-16 min-w-0 flex-1 items-center gap-3 px-3 md:px-0">
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          search={{}}
          aria-label={`Back to the chat with ${agent.name}`}
          className="flex size-10 shrink-0 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Link>
        <Familiar look={agent.spec.avatar} size={34} ring="var(--background)" />
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-[19px] leading-tight font-bold tracking-[-0.01em]">
            {agent.name}
          </h1>
          <span className="truncate text-[12.5px] text-muted-foreground">{agent.spec.job}</span>
        </div>
        {action && <div className="ml-auto shrink-0 md:hidden">{action}</div>}
      </div>
      <AgentTabs
        agent={agent}
        current={current}
        className="overflow-x-auto px-4 [scrollbar-width:none] md:px-0"
      />
      {action && <div className="hidden shrink-0 md:block">{action}</div>}
    </header>
  );
}
