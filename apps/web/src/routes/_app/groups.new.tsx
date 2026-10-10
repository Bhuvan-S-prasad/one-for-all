import { useAgents, useCreateThread } from "@ofa/client";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Crown } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// A new group chat (M5.04, M5.11): two to six agents, one of them leading.
// The leader answers anything that @mentions nobody, and brings the others in.

export const Route = createFileRoute("/_app/groups/new")({
  staticData: { title: "New group" },
  component: NewGroup,
});

const MAX = 6;

function NewGroup() {
  const { data: agents } = useAgents();
  const create = useCreateThread();
  const navigate = useNavigate();
  const ids = useId();
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const active = (agents ?? []).filter((a) => a.status === "active");
  const leader = lead && picked.includes(lead) ? lead : (picked[0] ?? null);

  const toggle = (id: string) =>
    setPicked((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : list.length < MAX ? [...list, id] : list,
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (picked.length < 2 || !leader) return;
    create.mutate(
      {
        agentIds: [leader, ...picked.filter((id) => id !== leader)],
        coordinatorAgentId: leader,
        ...(title.trim() ? { title: title.trim() } : {}),
      },
      {
        onSuccess: (thread) =>
          void navigate({ to: "/groups/$threadId", params: { threadId: thread.id } }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="eyebrow text-[11px] text-muted-foreground">Group chat</span>
        <h1 className="text-[40px] leading-[0.95] font-extrabold tracking-[-0.04em]">New group</h1>
        <p className="text-sm text-muted-foreground">
          Pick two to six agents and who leads. Write @name to ask one of them; anything else goes
          to the leader, which answers or hands parts to the others.
        </p>
      </header>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-title`}>Name (optional)</Label>
        <Input
          id={`${ids}-title`}
          value={title}
          maxLength={80}
          placeholder="Release crew"
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="eyebrow mb-1 text-muted-foreground">
          Agents · {picked.length} of up to {MAX}
        </legend>
        {active.length < 2 && (
          <p className="text-sm text-muted-foreground">
            A group needs at least two active agents. Hatch another one first.
          </p>
        )}
        <ul className="grid gap-2 sm:grid-cols-2">
          {active.map((agent) => {
            const on = picked.includes(agent.id);
            return (
              <li key={agent.id}>
                <label
                  className={cn(
                    "flex min-h-14 cursor-pointer items-center gap-3 rounded-[16px] border bg-card px-3 py-2",
                    on && "border-primary",
                  )}
                >
                  <input type="checkbox" checked={on} onChange={() => toggle(agent.id)} />
                  <Familiar look={agent.spec.avatar} size={32} ring="var(--card)" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">{agent.name}</span>
                    <span className="truncate text-[12.5px] text-muted-foreground">
                      {agent.spec.job}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {picked.length >= 2 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="eyebrow mb-1 flex items-center gap-1.5 text-muted-foreground">
            <Crown className="size-3.5" aria-hidden /> Who leads
          </legend>
          <div className="flex flex-wrap gap-2">
            {picked.map((id) => {
              const agent = active.find((a) => a.id === id);
              if (!agent) return null;
              return (
                <label
                  key={id}
                  className={cn(
                    "flex h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-semibold",
                    leader === id && "border-primary bg-primary/10",
                  )}
                >
                  <input
                    type="radio"
                    name={`${ids}-lead`}
                    checked={leader === id}
                    onChange={() => setLead(id)}
                  />
                  {agent.name}
                </label>
              );
            })}
          </div>
          <p className="text-[13px] text-muted-foreground">
            To route messages, the leader needs "Message other agents" or "Hand work to other
            agents" in its Tools.
          </p>
        </fieldset>
      )}
      {create.error && <ErrorAlert>{create.error.message}</ErrorAlert>}
      <Button type="submit" className="self-start" disabled={picked.length < 2 || create.isPending}>
        Start the group
      </Button>
    </form>
  );
}
