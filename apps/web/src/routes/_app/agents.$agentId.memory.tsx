import { useAgent, useMemories } from "@ofa/client";
import type { Agent, MemoryItem } from "@ofa/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { AgentPageHeader } from "@/components/agent-tabs";
import { FactRow, useForgetWithUndo } from "@/components/memory-review";
import { ErrorAlert } from "@/components/ui/alert";

// What an agent remembers (UX.14): facts waiting to be confirmed first, then
// what it uses, about you, its own notes, and what every agent shares.

export const Route = createFileRoute("/_app/agents/$agentId/memory")({
  staticData: { title: "Memory", fullBleed: true },
  component: MemoryPage,
});

function MemoryPage() {
  const { agentId } = Route.useParams();
  const { data: agent, error } = useAgent(agentId);
  if (error) {
    return (
      <div className="p-6">
        <ErrorAlert>{error.message}</ErrorAlert>
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading memory">
        <div className="h-16 border-b" />
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3 px-4 pt-6 md:px-8">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-16 w-full rounded-[16px]" />
          ))}
        </div>
      </div>
    );
  }
  return <Memory agent={agent} />;
}

const GROUPS: { title: string; match: (m: MemoryItem) => boolean }[] = [
  { title: "About you", match: (m) => m.scope === "agent_user" },
  { title: "Its own notes", match: (m) => m.scope === "agent" },
  { title: "Shared with every agent", match: (m) => m.scope === "workspace" },
];

function Memory({ agent }: { agent: Agent }) {
  const { data, isPending, error } = useMemories({ agentId: agent.id });
  const { hidden, forget } = useForgetWithUndo();
  const [text, setText] = useState("");
  const needle = text.trim().toLowerCase();
  const items = (data ?? []).filter(
    (m) => !hidden.has(m.id) && (!needle || m.content.toLowerCase().includes(needle)),
  );
  const unverified = items.filter((m) => !m.verified);
  const kept = items.filter((m) => m.verified);

  return (
    <div className="flex h-full flex-col">
      <AgentPageHeader agent={agent} current="memory" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-6 px-4 pt-5 pb-16 md:px-8">
          {error && <ErrorAlert>{error.message}</ErrorAlert>}
          {isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-16 w-full rounded-[16px]" />
              ))}
            </div>
          ) : (data ?? []).length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <h2 className="text-[20px] font-bold">Nothing remembered yet</h2>
              <p className="max-w-[420px] text-sm text-muted-foreground">
                After a chat, {agent.name} looks back for facts and preferences worth keeping. They
                show up here, and you can forget any of them.
              </p>
            </div>
          ) : (
            <>
              {(data ?? []).length > 6 && (
                <label className="relative block">
                  <span className="sr-only">Search memory</span>
                  <Search
                    className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <input
                    type="search"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={`Search what ${agent.name} remembers`}
                    className="h-11 w-full rounded-full border border-input bg-card pr-4 pl-10 text-[15px] outline-none placeholder:text-muted-foreground focus:border-ring/60"
                  />
                </label>
              )}
              {unverified.length > 0 && (
                <section aria-labelledby="to-confirm" className="flex flex-col gap-2.5">
                  <div className="flex flex-col gap-1 px-1">
                    <h2 id="to-confirm" className="text-[17px] font-bold">
                      To confirm · {unverified.length}
                    </h2>
                    <p className="text-[13px] text-muted-foreground">
                      Learned while reading outside content. {agent.name} won't use these until you
                      keep them.
                    </p>
                  </div>
                  <ul className="flex flex-col gap-2">
                    {unverified.map((m) => (
                      <FactRow key={m.id} item={m} onForget={forget} />
                    ))}
                  </ul>
                </section>
              )}
              {GROUPS.map((group) => {
                const list = kept.filter(group.match);
                if (list.length === 0) return null;
                return (
                  <section key={group.title} className="flex flex-col gap-1">
                    <h2 className="eyebrow px-1 text-[11px] text-muted-foreground">
                      {group.title} · {list.length}
                    </h2>
                    <ul className="flex flex-col divide-y px-1">
                      {list.map((m) => (
                        <FactRow key={m.id} item={m} onForget={forget} compact />
                      ))}
                    </ul>
                  </section>
                );
              })}
              {needle && items.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nothing matches “{text.trim()}”.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
