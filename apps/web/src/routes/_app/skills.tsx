import { useAgents, useCreateSkill, useDeleteSkill, useSkills, useUpdateSkill } from "@ofa/client";
import { skillSlug, type Agent, type Skill } from "@ofa/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, BookOpen, Check, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { ComingSoon } from "@/components/coming-soon";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, Textarea } from "@/components/ui/textarea";
import { HOUSEHOLD } from "@/lib/familiars";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// The skills library (M5.08, M5.11): step-by-step instructions agents follow
// when you write /name in a message. Skills an agent saved after reading
// outside content, and those the nightly tidy-up proposes, wait here for you.

export const Route = createFileRoute("/_app/skills")({
  staticData: { title: "Skills" },
  component: SkillsPage,
});

const TABS = [
  { key: "active", label: "In use" },
  { key: "proposed", label: "To review" },
  { key: "archived", label: "Retired" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function SkillsPage() {
  const { data: skills, isPending, error } = useSkills();
  const { data: agents } = useAgents();
  const [tab, setTab] = useState<Tab>("active");
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const count = (key: Tab) => (skills ?? []).filter((s) => s.status === key).length;
  const shown = (skills ?? []).filter((s) => s.status === tab);

  if (error) return <ErrorAlert>Couldn't load skills: {error.message}</ErrorAlert>;

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-[11px] text-muted-foreground">How your agents work</span>
          <h1 className="text-[40px] leading-[0.95] font-extrabold tracking-[-0.04em]">Skills</h1>
        </div>
        {editing === null && (
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden /> New skill
          </Button>
        )}
      </header>

      {editing !== null && (
        <SkillForm
          agents={agents ?? []}
          skill={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}

      <div
        role="tablist"
        aria-label="Skills"
        className="flex gap-1 self-start rounded-full border p-1"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tab === t.key ? "bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            {t.label}
            {count(t.key) > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 font-mono text-[11px]",
                  t.key === "proposed" && tab !== t.key && "bg-primary text-primary-foreground",
                )}
              >
                {count(t.key)}
              </span>
            )}
          </button>
        ))}
      </div>

      {isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading skills">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-24 w-full rounded-[18px]" />
          ))}
        </div>
      ) : (skills ?? []).length === 0 && editing === null ? (
        <ComingSoon
          familiar={HOUSEHOLD.chef}
          mood="idle"
          badge="Nothing saved yet"
          heading="No skills yet"
        >
          A skill is a recipe an agent follows: a name, when to use it, and its steps. Write one
          here, or ask an agent to save how it did something. Then write /its-name in a chat.
        </ComingSoon>
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {tab === "proposed" ? "Nothing waiting for review." : "Nothing here."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              agent={skill.agentId ? byId.get(skill.agentId) : undefined}
              onEdit={() => setEditing(skill)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function sourceWords(skill: Skill, agent: Agent | undefined): string {
  if (skill.source === "consolidation") return "Proposed by the nightly tidy-up";
  if (skill.source === "agent") return `Saved by ${agent?.name ?? "an agent"}`;
  return skill.status === "proposed" ? "Imported with an agent" : "Written by a person";
}

function SkillCard({
  skill,
  agent,
  onEdit,
}: {
  skill: Skill;
  agent: Agent | undefined;
  onEdit: () => void;
}) {
  const update = useUpdateSkill();
  const remove = useDeleteSkill();
  const fail = (error: Error) => toast({ message: error.message, tone: "error" });
  const setStatus = (status: Skill["status"], message: string) =>
    update.mutate(
      { id: skill.id, patch: { status } },
      { onSuccess: () => toast({ message }), onError: fail },
    );

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-[18px] border bg-card p-4 md:p-5",
        skill.status === "proposed" && "border-primary/50",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        {agent ? (
          <Familiar look={agent.spec.avatar} size={36} ring="var(--card)" />
        ) : (
          <span className="flex size-9 items-center justify-center rounded-full bg-accent">
            <BookOpen className="size-4" aria-hidden />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-[18px] font-bold">{skill.name}</h2>
            <code className="font-mono text-[12.5px] text-muted-foreground">/{skill.slug}</code>
          </div>
          <p className="text-[14.5px]">{skill.description}</p>
          <p className="text-[12.5px] text-muted-foreground">
            {agent ? `${agent.name}'s` : "Every agent"} · {sourceWords(skill, agent)}
          </p>
        </div>
      </div>
      <ol className="ml-1 flex list-decimal flex-col gap-1 pl-5 text-[14px] text-muted-foreground">
        {skill.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {skill.status === "proposed" && (
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => setStatus("active", `/${skill.slug} is now in use`)}
          >
            <Check aria-hidden /> Approve
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil aria-hidden /> Edit
        </Button>
        {skill.status === "archived" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => setStatus("active", `/${skill.slug} is back in use`)}
          >
            <RotateCcw aria-hidden /> Use again
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => setStatus("archived", `/${skill.slug} retired`)}
          >
            <Archive aria-hidden /> {skill.status === "proposed" ? "Dismiss" : "Retire"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label={`Delete /${skill.slug}`}
          disabled={remove.isPending}
          onClick={() => {
            if (!window.confirm(`Delete the skill /${skill.slug}?`)) return;
            remove.mutate(skill.id, {
              onSuccess: () => toast({ message: "Skill deleted" }),
              onError: fail,
            });
          }}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

function SkillForm({
  agents,
  skill,
  onDone,
}: {
  agents: readonly Agent[];
  skill: Skill | null;
  onDone: () => void;
}) {
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const ids = useId();
  const [name, setName] = useState(skill?.name ?? "");
  const [slug, setSlug] = useState(skill?.slug ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [steps, setSteps] = useState((skill?.steps ?? []).join("\n"));
  const [agentId, setAgentId] = useState(skill?.agentId ?? "");
  const list = steps
    .split("\n")
    .map((s) => s.replace(/^\s*(\d+[.)]|[-*])\s*/, "").trim())
    .filter(Boolean);
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (skill) {
      update.mutate(
        { id: skill.id, patch: { name, description, steps: list } },
        { onSuccess: onDone },
      );
    } else {
      create.mutate(
        {
          name,
          slug: slug || skillSlug(name),
          description,
          steps: list,
          ...(agentId ? { agentId } : {}),
        },
        { onSuccess: onDone },
      );
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-label={skill ? `Edit /${skill.slug}` : "New skill"}
      className="flex flex-col gap-5 rounded-[18px] border bg-card p-5 md:p-6"
    >
      <h2 className="text-[20px] font-bold">{skill ? `Edit /${skill.slug}` : "New skill"}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-name`}>Name</Label>
          <Input
            id={`${ids}-name`}
            value={name}
            required
            minLength={2}
            maxLength={80}
            placeholder="Release note"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {!skill && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-slug`}>Handle</Label>
            <Input
              id={`${ids}-slug`}
              value={slug}
              placeholder={name ? skillSlug(name) : "release-note"}
              pattern="[a-z0-9][a-z0-9-]{1,59}"
              className="font-mono"
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-description`}>When to use it</Label>
        <Input
          id={`${ids}-description`}
          value={description}
          required
          minLength={5}
          maxLength={500}
          placeholder="Announcing a release to the team"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-steps`}>Steps, one per line</Label>
        <Textarea
          id={`${ids}-steps`}
          value={steps}
          required
          placeholder={
            "Start with a one-line headline\nAdd two bullet points with the key facts\nSign off as the team"
          }
          onChange={(e) => setSteps(e.target.value)}
        />
        <p className="text-[13px] text-muted-foreground">
          {list.length} step{list.length === 1 ? "" : "s"} (up to 20). Instructions only: anything
          the agent does still goes through its permissions.
        </p>
      </div>
      {!skill && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-agent`}>Who can use it</Label>
          <Select id={`${ids}-agent`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Every agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                Only {a.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {error && <ErrorAlert>{error.message}</ErrorAlert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || list.length === 0 || list.length > 20}>
          {skill ? "Save" : "Create skill"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
