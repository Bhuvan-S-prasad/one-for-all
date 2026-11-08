import { queryKeys, useAgents, useApiClient } from "@ofa/client";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, SquarePen, Users } from "lucide-react";
import { useCallback, useState } from "react";
import { Familiar } from "@/components/familiar";
import { MENU_ITEM, PopoverPanel, useDismiss } from "@/components/ui/popover";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// "New chat" (ADR-0052): pick an agent for a fresh chat, start a group, or
// hatch a new agent. One button instead of a "+" under each list.

export function NewChatMenu({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const { data: agents } = useAgents();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const active = (agents ?? []).filter((a) => a.status === "active");

  const start = (agentId: string) => {
    close();
    void api
      .newThread(agentId)
      .then((thread) => {
        queryClient.setQueryData(queryKeys.agentThread(agentId), thread);
        void queryClient.invalidateQueries({ queryKey: queryKeys.threadLists });
        return navigate({ to: "/agents/$agentId", params: { agentId }, search: {} });
      })
      .catch((e: Error) => toast({ message: e.message, tone: "error" }));
  };

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="New chat"
        title="New chat"
        onClick={() => setOpen(!open)}
        className="press flex size-9 items-center justify-center rounded-full text-sidebar-muted outline-none hover:bg-white/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
      >
        <SquarePen className="size-[18px]" aria-hidden />
      </button>
      {open && (
        <PopoverPanel place="below-end" label="New chat" className="max-h-[70vh] overflow-y-auto">
          {active.length > 0 && (
            <span className="eyebrow px-3 pt-1.5 pb-1 text-[10.5px] text-muted-foreground">
              Chat with
            </span>
          )}
          {active.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => start(agent.id)}
            >
              <Familiar look={agent.spec.avatar} size={24} ring="var(--popover)" />
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
          {active.length > 0 && <div className="my-1 border-t" />}
          <Link to="/groups/new" role="menuitem" className={MENU_ITEM} onClick={close}>
            <Users className="size-4 text-muted-foreground" aria-hidden /> New group chat
          </Link>
          <Link to="/agents/new" role="menuitem" className={MENU_ITEM} onClick={close}>
            <Plus className="size-4 text-muted-foreground" aria-hidden /> Hatch an agent
          </Link>
        </PopoverPanel>
      )}
    </div>
  );
}
