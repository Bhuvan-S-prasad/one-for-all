import { useAgents, useConsolidateMemory, useEpisodes, useMemories, useSession } from "@ofa/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { EpisodeRow } from "@/components/episode-row";
import { FactRow, useForgetWithUndo } from "@/components/memory-review";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// The workspace's memory (M5.09, M5.11): what every agent shares, each
// agent's notes at a glance, and the recent work agents remember. Each night
// at 3 the tidy-up merges what says the same and proposes skills; owners can
// ask for it now.

export const Route = createFileRoute("/_app/memory")({
  staticData: { title: "Memory" },
  component: MemoryPage,
});

function MemoryPage() {
  const { data: session } = useSession();
  const { data: agents } = useAgents();
  const { data: facts, isPending, error } = useMemories({});
  const { data: episodes } = useEpisodes();
  const tidy = useConsolidateMemory();
  const { hidden, forget } = useForgetWithUndo();
  const role = session?.workspace?.role;
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const live = (facts ?? []).filter((m) => !hidden.has(m.id));
  const shared = live.filter((m) => m.scope === "workspace" && m.verified);
  const perAgent = (agents ?? [])
    .map((agent) => ({
      agent,
      facts: live.filter((m) => m.agentId === agent.id).length,
      toConfirm: live.filter((m) => m.agentId === agent.id && !m.verified).length,
    }))
    .filter((row) => row.facts > 0);

  if (error) return <ErrorAlert>Couldn't load memory: {error.message}</ErrorAlert>;

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-[11px] text-muted-foreground">What your agents know</span>
          <h1 className="text-[40px] leading-[0.95] font-extrabold tracking-[-0.04em]">Memory</h1>
        </div>
        {(role === "owner" || role === "admin") && (
          <Button
            variant="outline"
            disabled={tidy.isPending}
            onClick={() =>
              tidy.mutate(undefined, {
                onSuccess: () =>
                  toast({
                    message:
                      "Tidying up now: duplicates merge and new skills may wait for you in Skills.",
                  }),
                onError: (e) => toast({ message: e.message, tone: "error" }),
              })
            }
          >
            <Sparkles aria-hidden /> Tidy up now
          </Button>
        )}
      </header>
      <p className="-mt-3 text-sm text-muted-foreground">
        Each night at 3, agents merge facts that say the same thing, forget ones nobody confirmed or
        used for a long time, and suggest skills from work they repeat.
      </p>

      <section aria-labelledby="shared" className="flex flex-col gap-2">
        <h2 id="shared" className="text-[17px] font-bold">
          Shared with every agent · {shared.length}
        </h2>
        {isPending ? (
          <div className="skeleton h-16 w-full rounded-[16px]" />
        ) : shared.length === 0 ? (
          <p className="text-[13.5px] text-muted-foreground">
            Nothing yet. When you tell an agent something true for the whole team, such as the tools
            you use or when you ship, it is kept here for every agent.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-[18px] border bg-card px-3">
            {shared.map((m) => (
              <FactRow key={m.id} item={m} onForget={forget} compact />
            ))}
          </ul>
        )}
      </section>

      {perAgent.length > 0 && (
        <section aria-labelledby="per-agent" className="flex flex-col gap-2">
          <h2 id="per-agent" className="text-[17px] font-bold">
            Each agent's memory
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {perAgent.map(({ agent, facts: n, toConfirm }) => (
              <li key={agent.id}>
                <Link
                  to="/agents/$agentId/memory"
                  params={{ agentId: agent.id }}
                  className="flex min-h-14 items-center gap-3 rounded-[16px] border bg-card px-3 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Familiar look={agent.spec.avatar} size={32} ring="var(--card)" />
                  <span className="flex-1 truncate font-semibold">{agent.name}</span>
                  <span className="font-mono text-[12px] text-muted-foreground">{n} facts</span>
                  {toConfirm > 0 && (
                    <span className="eyebrow rounded-full bg-primary px-1.5 py-px text-[10px] text-primary-foreground">
                      {toConfirm} to confirm
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="recent-work" className="flex flex-col gap-2">
        <h2 id="recent-work" className="text-[17px] font-bold">
          Recent work
        </h2>
        <p className="text-[13px] text-muted-foreground">
          What each run was asked and how it ended. Agents recall the closest ones when similar work
          comes up.
        </p>
        {!episodes?.length ? (
          <p className="text-[13.5px] text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-[18px] border bg-card">
            {episodes.map((e) => (
              <EpisodeRow key={e.id} agent={byId.get(e.agentId)} episode={e} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
