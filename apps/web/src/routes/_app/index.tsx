import { useAgents, useHealth, useLlmSettings, useRuns } from "@ofa/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Familiar } from "@/components/familiar";
import { Card, CardTitle } from "@/components/ui/card";
import { useAgentMoods } from "@/lib/agents";
import { firstName, partOfDay, shortDate } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/")({
  staticData: { title: "Home" },
  component: HomePage,
});

interface Step {
  title: string;
  body: string;
  done: boolean;
  /** Where to go to do it; omitted for steps that arrive later. */
  to?: "/settings" | "/agents/new";
}
/** Plain sleeping silhouettes in the hero: slots for agents not hatched yet. */
const EMPTY_SLOTS = [
  { form: "ghost", size: 116 },
  { form: "bloom", size: 148 },
  { form: "totem", size: 116 },
] as const;

function HomePage() {
  const { session } = Route.useRouteContext();
  const { dark } = useTheme();
  const { data: agents } = useAgents();
  const { data: runs } = useRuns();
  const { data: llm } = useLlmSettings();
  const moods = useAgentMoods(agents);
  const now = new Date();
  const today = now.toDateString();
  const steps: Step[] = [
    { title: "Create the owner account and workspace", body: "Done during setup.", done: true },
    {
      title: "Add your model key",
      body: "Agents run on your own key. Free models work.",
      done: !!llm?.key.configured,
      to: "/settings",
    },
    {
      title: "Hatch your first agent",
      body: "Give it one job, a look, and the tools it may use.",
      done: (agents?.length ?? 0) > 0,
      to: "/agents/new",
    },
    {
      title: "Connect a channel",
      body: "Reach agents from Telegram or Slack. No public URL needed.",
      done: false,
    },
  ];
  const done = steps.filter((step) => step.done).length;
  const counters = [
    {
      label: "Agents",
      value: agents?.length ?? 0,
      note: agents?.length ? "In the den" : "None hatched yet",
    },
    {
      label: "Runs today",
      value: (runs ?? []).filter((r) => new Date(r.createdAt).toDateString() === today).length,
      note: "Across all agents",
    },
    // Approvals arrive in M4; until then nothing can wait on a person.
    { label: "Waiting for you", value: 0, note: "No approvals pending" },
  ];
  const shown = (agents ?? []).slice(0, 3);
  // Empty slots in the hero: asleep, in a tone of the hero colour.
  const dormant = dark ? "#b5e01f" : "#2c2c31";

  return (
    <div className="flex flex-col gap-4">
      <section className="grid overflow-hidden rounded-xl bg-hero px-6 pt-7 text-hero-foreground md:h-[236px] md:grid-cols-[minmax(0,1fr)_380px] md:gap-6 md:px-8 md:pt-7.5">
        <div className="flex flex-col gap-3 pb-7 md:pb-7.5">
          <span className="eyebrow opacity-70">{shortDate(now)}</span>
          <h2 className="text-[52px] leading-[0.9] font-extrabold tracking-[-0.045em] md:text-[76px]">
            {partOfDay(now)}, {firstName(session.user.name)}.
          </h2>
          <p className="max-w-[440px] text-base leading-snug opacity-80">
            {shown.length
              ? `${shown.length === 1 ? shown[0]?.name : `${shown.length} agents`} in the den. Say hello, or give one a job.`
              : "Your workspace is ready. Agents come next; here’s what they’ll need."}
          </p>
        </div>
        <div aria-hidden className="hidden items-end justify-center sm:flex">
          {shown.length
            ? shown.map((agent, i) => (
                <Link
                  key={agent.id}
                  to="/agents/$agentId"
                  params={{ agentId: agent.id }}
                  aria-label={`Chat with ${agent.name}`}
                >
                  <Familiar
                    look={agent.spec.avatar}
                    mood={moods.get(agent.id)?.mood ?? "idle"}
                    size={EMPTY_SLOTS[i]?.size ?? 116}
                    ring="var(--hero)"
                  />
                </Link>
              ))
            : EMPTY_SLOTS.map((slot) => (
                <Familiar
                  key={slot.form}
                  look={{
                    form: slot.form,
                    eyes: "googly",
                    skin: "solid",
                    color: "ink",
                    mark: "none",
                  }}
                  mood="asleep"
                  bodyColor={dormant}
                  size={slot.size}
                  ring="var(--hero)"
                />
              ))}
        </div>
      </section>

      <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
        {counters.map((counter) => (
          <Card
            key={counter.label}
            className="flex flex-col-reverse gap-2 px-3.5 py-3.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3 sm:px-5 sm:py-4"
          >
            <div className="flex flex-col gap-1">
              <span className="eyebrow text-[10px] text-muted-foreground sm:text-[11px]">
                {counter.label}
              </span>
              <span className="hidden text-[13px] text-muted-foreground lg:block">
                {counter.note}
              </span>
            </div>
            <span className="font-display text-[40px] leading-[0.85] font-extrabold tracking-[-0.04em] sm:text-[64px]">
              {String(counter.value).padStart(2, "0")}
            </span>
          </Card>
        ))}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <div className="flex items-baseline justify-between px-5 pt-4 pb-3">
            <CardTitle>Get started</CardTitle>
            <span className="font-mono text-xs text-muted-foreground">
              {done} / {steps.length}
            </span>
          </div>
          <ol>
            {steps.map((step, index) => (
              <li key={step.title} className="flex items-center gap-4 border-t px-5 py-3">
                <span className="w-5.5 font-mono text-[13px] text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="flex flex-1 flex-col gap-px">
                  <span
                    className={cn(
                      "text-[15px] font-semibold",
                      step.done && "line-through decoration-muted-foreground",
                    )}
                  >
                    {step.title}
                  </span>
                  <span className="text-[13px] text-muted-foreground">{step.body}</span>
                </div>
                {step.done ? (
                  <span className="eyebrow rounded-full bg-success px-2.5 py-1 text-[11px] text-background">
                    Done
                  </span>
                ) : step.to ? (
                  <Link
                    to={step.to}
                    className="eyebrow rounded-full bg-primary px-2.5 py-1 text-[11px] text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Do it
                  </Link>
                ) : (
                  <span className="eyebrow rounded-full border px-2.5 py-[3px] text-[11px] font-normal text-muted-foreground">
                    Soon
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Card>
        <SystemCard />
      </div>
    </div>
  );
}

function SystemCard() {
  const health = useHealth();
  const host = window.location.host;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

  return (
    <Card className="flex flex-col gap-3 px-5 py-4">
      <CardTitle>System</CardTitle>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 font-mono text-[13px]">
        <dt className="text-muted-foreground">API</dt>
        <Status
          loading={health.isPending}
          ok={health.data?.status === "ok"}
          okText="Healthy"
          badText={health.isError ? "Unreachable" : "Degraded"}
        />
        <dt className="text-muted-foreground">Database</dt>
        <Status
          loading={health.isPending}
          ok={health.data?.checks.database === "ok"}
          okText="Connected"
          badText={health.isError ? "Unknown" : "Not responding"}
        />
        <dt className="text-muted-foreground">Version</dt>
        <dd className="text-right">{health.data?.version ?? "–"}</dd>
        <dt className="text-muted-foreground">Address</dt>
        <dd className="truncate text-right">{host}</dd>
      </dl>
      {local && (
        <p className="border-t pt-3 text-[13px] text-muted-foreground">
          Reachable from this machine only.
        </p>
      )}
    </Card>
  );
}

function Status(props: { loading: boolean; ok: boolean; okText: string; badText: string }) {
  if (props.loading) return <dd className="text-right text-muted-foreground">Checking…</dd>;
  return (
    <dd className="flex items-center justify-end gap-2">
      <span
        aria-hidden
        className={cn("size-[7px] rounded-full", props.ok ? "bg-success" : "bg-destructive")}
      />
      {props.ok ? props.okText : props.badText}
    </dd>
  );
}
