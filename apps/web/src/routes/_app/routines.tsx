import {
  useAgents,
  useCancelSchedule,
  useCreateRoutine,
  useDeleteRoutine,
  useRoutineRuns,
  useRoutines,
  useRunRoutine,
  useSchedules,
  useUpdateRoutine,
  useWorkspaceSettings,
} from "@ofa/client";
import type { Agent, Routine, Schedule } from "@ofa/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, ChevronDown, Eye, Pause, Pencil, Play, Plus, Repeat, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { ComingSoon } from "@/components/coming-soon";
import { Familiar } from "@/components/familiar";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { HOUSEHOLD } from "@/lib/familiars";
import { timeAgo } from "@/lib/format";
import {
  cronToPreset,
  describeCron,
  presetToCron,
  WEEKDAY_NAMES,
  type SchedulePreset,
} from "@/lib/schedule";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Routines (M5.06, M5.11): each agent's standing jobs on a schedule, and the
// quiet checks that speak only when something needs you (M5.10). Below them,
// the reminders and tasks agents set for later (M5.07).

export const Route = createFileRoute("/_app/routines")({
  staticData: { title: "Routines" },
  component: RoutinesPage,
});

/** "Mon 07:00" in the routine's own time zone. */
function when(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function RoutinesPage() {
  const { data: routines, isPending, error } = useRoutines();
  const { data: agents } = useAgents();
  const { data: later } = useSchedules();
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));

  if (error) return <ErrorAlert>Couldn't load routines: {error.message}</ErrorAlert>;

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-[11px] text-muted-foreground">On their own schedule</span>
          <h1 className="text-[40px] leading-[0.95] font-extrabold tracking-[-0.04em]">Routines</h1>
        </div>
        {editing === null && (agents?.length ?? 0) > 0 && (
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden /> New routine
          </Button>
        )}
      </header>

      {editing !== null && (
        <RoutineForm
          agents={(agents ?? []).filter((a) => a.status !== "archived")}
          routine={editing === "new" ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}

      {isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading routines">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-28 w-full rounded-[18px]" />
          ))}
        </div>
      ) : routines.length === 0 && editing === null ? (
        <ComingSoon
          familiar={HOUSEHOLD.ledger}
          mood="asleep"
          badge="Nothing scheduled"
          heading="No routines yet"
        >
          A routine runs an agent on a schedule: a brief every weekday morning, or a quiet check
          every hour that only speaks up when something needs you.
        </ComingSoon>
      ) : (
        <ul className="flex flex-col gap-3">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              agent={byId.get(routine.agentId)}
              onEdit={() => setEditing(routine)}
            />
          ))}
        </ul>
      )}

      {(later?.length ?? 0) > 0 && (
        <section aria-labelledby="later" className="flex flex-col gap-2.5">
          <h2 id="later" className="text-[17px] font-bold">
            Set for later · {later!.length}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            Reminders and tasks agents set in your chats. A reminder is posted as written; a task
            wakes the agent to do it.
          </p>
          <ul className="flex flex-col divide-y rounded-[18px] border bg-card">
            {later!.map((item) => (
              <LaterRow key={item.id} item={item} agent={byId.get(item.agentId)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatusPill({ routine }: { routine: Routine }) {
  const paused = routine.status === "paused";
  const label = !paused
    ? "Active"
    : routine.pausedReason === "inactive"
      ? "Paused · you were away"
      : "Paused";
  return (
    <span
      className={cn(
        "eyebrow flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[10.5px]",
        paused ? "bg-accent text-muted-foreground" : "bg-primary/15 text-primary",
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function RoutineCard({
  routine,
  agent,
  onEdit,
}: {
  routine: Routine;
  agent: Agent | undefined;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const update = useUpdateRoutine();
  const run = useRunRoutine();
  const remove = useDeleteRoutine();
  const historyId = useId();
  const paused = routine.status === "paused";
  const fail = (error: Error) => toast({ message: error.message, tone: "error" });

  return (
    <li className="flex flex-col gap-3 rounded-[18px] border bg-card p-4 md:p-5">
      <div className="flex flex-wrap items-start gap-3">
        {agent && <Familiar look={agent.spec.avatar} size={40} ring="var(--card)" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[18px] font-bold">{routine.name}</h2>
            <StatusPill routine={routine} />
            {routine.kind === "check" && (
              <span className="eyebrow flex h-6 items-center gap-1 rounded-full border px-2 text-[10.5px] text-muted-foreground">
                <Eye className="size-3" aria-hidden /> Quiet check
              </span>
            )}
          </div>
          <p className="text-[13.5px] text-muted-foreground">
            {agent?.name ?? "An agent"} · {describeCron(routine.cron)} ({routine.timeZone})
            {routine.nextRunAt ? ` · next ${when(routine.nextRunAt, routine.timeZone)}` : ""}
          </p>
          <p className="line-clamp-2 text-[14.5px]">{routine.instructions}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={run.isPending || agent?.status !== "active"}
          onClick={() =>
            run.mutate(routine.id, {
              onSuccess: () =>
                toast({
                  message: `${agent?.name ?? "The agent"} is running “${routine.name}” now`,
                }),
              onError: fail,
            })
          }
        >
          <Play aria-hidden /> Run now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={update.isPending}
          onClick={() =>
            update.mutate(
              { id: routine.id, patch: { status: paused ? "active" : "paused" } },
              {
                onSuccess: () => toast({ message: paused ? "Routine resumed" : "Routine paused" }),
                onError: fail,
              },
            )
          }
        >
          {paused ? <Play aria-hidden /> : <Pause aria-hidden />} {paused ? "Resume" : "Pause"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <Pencil aria-hidden /> Edit
        </Button>
        <Link
          to="/agents/$agentId"
          params={{ agentId: routine.agentId }}
          search={{ thread: routine.threadId }}
          className="inline-flex h-9 items-center rounded-full px-4 text-sm font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open its chat
        </Link>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-muted-foreground"
          aria-expanded={open}
          aria-controls={historyId}
          onClick={() => setOpen(!open)}
        >
          History <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delete ${routine.name}`}
          disabled={remove.isPending}
          onClick={() => {
            if (!window.confirm(`Delete “${routine.name}”? Its chat and past runs stay.`)) return;
            remove.mutate(routine.id, {
              onSuccess: () => toast({ message: "Routine deleted" }),
              onError: fail,
            });
          }}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      {open && <History id={historyId} routineId={routine.id} />}
    </li>
  );
}

const RUN_WORDS: Record<string, string> = {
  queued: "Waiting to start",
  running: "Running",
  waiting: "Waiting",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

function History({ id, routineId }: { id: string; routineId: string }) {
  const { data: runs, isPending } = useRoutineRuns(routineId);
  return (
    <div id={id} className="rounded-[14px] border bg-background/40 p-3">
      {isPending ? (
        <div className="skeleton h-10 w-full rounded-[10px]" />
      ) : !runs?.length ? (
        <p className="text-[13px] text-muted-foreground">It hasn't run yet.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center gap-3 text-[13.5px]">
              <span
                className={cn(
                  "font-mono text-[11.5px]",
                  r.status === "failed" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {RUN_WORDS[r.status] ?? r.status}
              </span>
              <span className="text-muted-foreground">
                {r.trigger === "manual" ? "test run" : "on schedule"} · {timeAgo(r.createdAt)}
              </span>
              <Link
                to="/activity"
                search={{ run: r.id }}
                className="ml-auto underline-offset-2 hover:underline"
              >
                Details
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LaterRow({ item, agent }: { item: Schedule; agent: Agent | undefined }) {
  const cancel = useCancelSchedule();
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {item.kind === "reminder" ? (
        <Bell className="size-4 shrink-0 text-muted-foreground" aria-label="Reminder" />
      ) : (
        <Repeat className="size-4 shrink-0 text-muted-foreground" aria-label="Task" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14.5px]">{item.content}</span>
        <span className="text-[12.5px] text-muted-foreground">
          {agent?.name ?? "An agent"} · {new Date(item.dueAt).toLocaleString()}
        </span>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={cancel.isPending}
        onClick={() =>
          cancel.mutate(item.id, {
            onSuccess: () => toast({ message: "Cancelled" }),
            onError: (error) => toast({ message: error.message, tone: "error" }),
          })
        }
      >
        Cancel
      </Button>
    </li>
  );
}

const ZONES: readonly string[] = (() => {
  try {
    return (
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ??
      []
    );
  } catch {
    return [];
  }
})();

function RoutineForm({
  agents,
  routine,
  onDone,
}: {
  agents: readonly Agent[];
  routine: Routine | null;
  onDone: () => void;
}) {
  const { data: settings } = useWorkspaceSettings();
  const create = useCreateRoutine();
  const update = useUpdateRoutine();
  const ids = useId();
  const [agentId, setAgentId] = useState(routine?.agentId ?? agents[0]?.id ?? "");
  const [name, setName] = useState(routine?.name ?? "");
  const [instructions, setInstructions] = useState(routine?.instructions ?? "");
  const [kind, setKind] = useState<Routine["kind"]>(routine?.kind ?? "task");
  const [preset, setPreset] = useState<SchedulePreset>(
    routine ? cronToPreset(routine.cron) : { kind: "weekdays", time: "07:00" },
  );
  const [timeZone, setTimeZone] = useState(routine?.timeZone ?? "");
  const zone = timeZone || settings?.timeZone || "UTC";
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cron = presetToCron(preset);
    const done = { onSuccess: onDone };
    if (routine) {
      update.mutate(
        { id: routine.id, patch: { name, instructions, kind, cron, timeZone: zone } },
        done,
      );
    } else {
      create.mutate({ agentId, name, instructions, kind, cron, timeZone: zone }, done);
    }
  };

  const setKindOf = (next: SchedulePreset["kind"]) => {
    if (next === preset.kind) return;
    setPreset(
      next === "custom"
        ? { kind: "custom", cron: presetToCron(preset) }
        : next === "hourly"
          ? { kind: "hourly", every: 1, minute: 0 }
          : next === "weekly"
            ? { kind: "weekly", day: 1, time: "09:00" }
            : { kind: next, time: "time" in preset ? preset.time : "07:00" },
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={routine ? `Edit ${routine.name}` : "New routine"}
      className="flex flex-col gap-5 rounded-[18px] border bg-card p-5 md:p-6"
    >
      <h2 className="text-[20px] font-bold">
        {routine ? `Edit “${routine.name}”` : "New routine"}
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-agent`}>Agent</Label>
          <Select
            id={`${ids}-agent`}
            value={agentId}
            disabled={!!routine}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-name`}>Name</Label>
          <Input
            id={`${ids}-name`}
            value={name}
            required
            maxLength={80}
            placeholder="Morning brief"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-instructions`}>What to do each time</Label>
        <Textarea
          id={`${ids}-instructions`}
          value={instructions}
          required
          maxLength={4000}
          placeholder="Summarise what changed overnight in the projects I follow. Use /skill-name to follow a skill."
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="eyebrow mb-1 text-muted-foreground">How it reports</legend>
        <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border p-3 has-[:checked]:border-primary">
          <input
            type="radio"
            name={`${ids}-kind`}
            className="mt-1"
            checked={kind === "task"}
            onChange={() => setKind("task")}
          />
          <span className="flex flex-col">
            <span className="font-semibold">Do the job and reply each time</span>
            <span className="text-[13px] text-muted-foreground">
              It can use all its tools; anything outbound still follows its permissions.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border p-3 has-[:checked]:border-primary">
          <input
            type="radio"
            name={`${ids}-kind`}
            className="mt-1"
            checked={kind === "check"}
            onChange={() => setKind("check")}
          />
          <span className="flex flex-col">
            <span className="font-semibold">Check quietly, speak only when something needs me</span>
            <span className="text-[13px] text-muted-foreground">
              Read-only: it can look, never change or send anything.
            </span>
          </span>
        </label>
      </fieldset>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${ids}-when`}>When</Label>
          <Select
            id={`${ids}-when`}
            value={preset.kind}
            onChange={(e) => setKindOf(e.target.value as SchedulePreset["kind"])}
          >
            <option value="weekdays">Weekdays</option>
            <option value="daily">Every day</option>
            <option value="weekly">Once a week</option>
            <option value="hourly">Every few hours</option>
            <option value="custom">Custom (cron)</option>
          </Select>
        </div>
        {preset.kind === "weekly" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-day`}>Day</Label>
            <Select
              id={`${ids}-day`}
              value={preset.day}
              onChange={(e) => setPreset({ ...preset, day: Number(e.target.value) })}
            >
              {WEEKDAY_NAMES.map((day, i) => (
                <option key={day} value={i}>
                  {day}
                </option>
              ))}
            </Select>
          </div>
        )}
        {(preset.kind === "daily" || preset.kind === "weekdays" || preset.kind === "weekly") && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-time`}>Time</Label>
            <Input
              id={`${ids}-time`}
              type="time"
              value={preset.time}
              required
              onChange={(e) => setPreset({ ...preset, time: e.target.value })}
            />
          </div>
        )}
        {preset.kind === "hourly" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${ids}-every`}>Every (hours)</Label>
            <Input
              id={`${ids}-every`}
              type="number"
              min={1}
              max={12}
              value={preset.every}
              onChange={(e) => setPreset({ ...preset, every: Number(e.target.value) || 1 })}
            />
          </div>
        )}
        {preset.kind === "custom" && (
          <div className="flex flex-col gap-2 md:col-span-2">
            <Label htmlFor={`${ids}-cron`}>Cron (minute hour day month weekday)</Label>
            <Input
              id={`${ids}-cron`}
              value={preset.cron}
              required
              className="font-mono"
              onChange={(e) => setPreset({ kind: "custom", cron: e.target.value })}
            />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-zone`}>Time zone</Label>
        <Input
          id={`${ids}-zone`}
          list={`${ids}-zones`}
          value={timeZone}
          placeholder={settings?.timeZone ?? "UTC"}
          onChange={(e) => setTimeZone(e.target.value)}
        />
        <datalist id={`${ids}-zones`}>
          {ZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <p className="text-[13px] text-muted-foreground">
          {describeCron(presetToCron(preset))}, {zone}. At most every 15 minutes.
        </p>
      </div>
      {error && <ErrorAlert>{error.message}</ErrorAlert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || !agentId}>
          {routine ? "Save" : "Create routine"}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
