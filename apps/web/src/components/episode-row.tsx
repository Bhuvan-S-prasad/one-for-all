import type { Agent, Episode } from "@ofa/contracts";
import { Link } from "@tanstack/react-router";
import { Familiar } from "@/components/familiar";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

// One episode (M5.09): what a run was asked and how it ended, linking to its
// details in Activity.

const OUTCOME: Record<Episode["outcome"], string> = {
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
};

export function EpisodeRow({ agent, episode }: { agent: Agent | undefined; episode: Episode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {agent && <Familiar look={agent.spec.avatar} size={28} ring="var(--card)" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14.5px]">{episode.summary}</span>
        <span className="text-[12px] text-muted-foreground">
          {agent?.name ?? "An agent"} · {timeAgo(episode.createdAt)}
          {episode.tainted ? " · read outside content, not recalled" : ""}
        </span>
      </div>
      <Link
        to="/activity"
        search={{ run: episode.runId }}
        className={cn(
          "font-mono text-[11.5px] underline-offset-2 hover:underline",
          episode.outcome === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {OUTCOME[episode.outcome]}
      </Link>
    </li>
  );
}
