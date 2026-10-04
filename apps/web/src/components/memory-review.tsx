import { queryKeys, useApiClient, useConfirmMemory } from "@ofa/client";
import type { MemoryItem } from "@ofa/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Trash2 } from "lucide-react";
import { useState } from "react";
import { timeAgo } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Reviewing what agents learned (UX.14). Facts learned while reading outside
// content are unverified: agents don't use them until a person keeps them
// (ARCHITECTURE.md §8). Forgetting waits five seconds, so Undo is real.

const KIND_WORDS: Record<MemoryItem["kind"], string> = {
  fact: "Fact",
  preference: "Preference",
  episode: "Event",
};

/** Where a fact came from, in plain words. */
export function sourceWords(item: MemoryItem): string {
  if (!item.verified) return "From outside content · not used until you keep it";
  if (item.scope === "agent_user") return "About you";
  if (item.scope === "workspace") return "Shared with every agent";
  return "Its own notes";
}

/**
 * Forget with Undo: the fact disappears at once, and is deleted when the toast
 * goes unless Undo was pressed. Returns the IDs hidden meanwhile.
 */
export function useForgetWithUndo(): {
  hidden: ReadonlySet<string>;
  forget: (item: MemoryItem) => void;
} {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const show = (id: string) =>
    setHidden((set) => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  const forget = (item: MemoryItem) => {
    setHidden((set) => new Set(set).add(item.id));
    toast({
      message: `Forgot “${item.content.slice(0, 48)}${item.content.length > 48 ? "…" : ""}”`,
      action: { label: "Undo", onClick: () => show(item.id) },
      // The API client and cache outlive this screen, so leaving it still commits.
      onEnd: (end) => {
        if (end === "action") return;
        api
          .forgetMemory(item.id)
          .catch(() => {
            show(item.id);
            toast({ message: "Couldn't forget that. It's still saved.", tone: "error" });
          })
          .finally(() => void queryClient.invalidateQueries({ queryKey: queryKeys.memoryLists }));
      },
    });
  };
  return { hidden, forget };
}

/** One learned fact: what it says, where it came from, Keep (if unverified) and Forget. */
export function FactRow({
  item,
  onForget,
  compact = false,
}: {
  item: MemoryItem;
  onForget: (item: MemoryItem) => void;
  compact?: boolean;
}) {
  const confirm = useConfirmMemory();
  return (
    <li
      className={cn(
        "flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4",
        compact ? "py-2.5" : "rounded-[16px] border bg-card px-4 py-3.5",
        !item.verified && !compact && "border-primary/40",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] leading-snug">“{item.content}”</span>
        <span className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
          <span className={cn("eyebrow text-[10px]", !item.verified && "text-highlight")}>
            {KIND_WORDS[item.kind]} · {item.verified ? "Kept" : "Unverified"}
          </span>
          {/* Grouped rows sit under a heading that already says where it came from. */}
          <span>
            {!compact || !item.verified ? `${sourceWords(item)} · ` : ""}
            {timeAgo(item.createdAt)}
          </span>
          {item.sourceRunId && !compact && (
            <Link
              to="/activity"
              search={{ run: item.sourceRunId }}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              · the run
            </Link>
          )}
        </span>
      </div>
      <div className="flex shrink-0 gap-1.5">
        {!item.verified && (
          <button
            type="button"
            onClick={() =>
              confirm.mutate(item.id, {
                onSuccess: () => toast("Kept. Agents can use it now."),
                onError: (e) => toast({ message: e.message, tone: "error" }),
              })
            }
            disabled={confirm.isPending}
            className="flex h-9 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <Check className="size-4" aria-hidden /> Keep
          </button>
        )}
        <button
          type="button"
          onClick={() => onForget(item)}
          aria-label={`Forget “${item.content.slice(0, 40)}”`}
          className="flex h-9 items-center gap-1.5 rounded-full border border-input px-3.5 text-[13px] font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 className="size-3.5" aria-hidden /> Forget
        </button>
      </div>
    </li>
  );
}
