import { useHealth } from "@ofa/client";
import { createFileRoute } from "@tanstack/react-router";
import { Circle, CircleCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { firstName } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/")({
  staticData: { title: "Home" },
  component: HomePage,
});

const STEPS = [
  {
    title: "Create the owner account and workspace",
    body: "Done during setup.",
    done: true,
  },
  {
    title: "Add your OpenRouter key",
    body: "Agents run on your own key. Free models work.",
    done: false,
  },
  {
    title: "Create your first agent",
    body: "Give it one job and the tools it may use.",
    done: false,
  },
  {
    title: "Connect a channel",
    body: "Reach agents from Telegram or Slack. No public URL needed.",
    done: false,
  },
];

function HomePage() {
  const { session } = Route.useRouteContext();
  const done = STEPS.filter((step) => step.done).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-3xl font-semibold">Good to see you, {firstName(session.user.name)}</h2>
        <p className="text-[15px] text-muted-foreground">
          Your workspace is ready. Agents come next; here’s what they’ll need.
        </p>
      </div>

      <div className="flex flex-col items-start gap-4 lg:flex-row">
        <Card className="w-full lg:flex-[2]">
          <div className="flex items-baseline justify-between px-5 pt-4.5 pb-3">
            <h3 className="text-lg font-semibold">Get started</h3>
            <span className="text-[13px] text-muted-foreground">
              {done} of {STEPS.length} done
            </span>
          </div>
          <ul>
            {STEPS.map((step) => (
              <li key={step.title} className="flex items-center gap-3.5 border-t px-5 py-3.5">
                {step.done ? (
                  <CircleCheck className="size-5 shrink-0 text-success" aria-label="Done" />
                ) : (
                  <Circle className="size-5 shrink-0 text-muted-foreground" aria-label="Not done" />
                )}
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">{step.title}</span>
                  <span className="text-[13px] text-muted-foreground">{step.body}</span>
                </div>
                {step.done ? (
                  <span className="text-xs font-semibold text-success">Done</span>
                ) : (
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                    Soon
                  </span>
                )}
              </li>
            ))}
          </ul>
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
  const apiOk = health.data?.status === "ok";
  const dbOk = health.data?.checks.database === "ok";

  return (
    <Card className="flex w-full flex-col gap-3.5 p-5 lg:flex-1">
      <h3 className="text-lg font-semibold">System</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
        <dt className="text-muted-foreground">API</dt>
        <StatusValue
          loading={health.isPending}
          ok={apiOk}
          okText="Healthy"
          badText={health.isError ? "Unreachable" : "Degraded"}
        />
        <dt className="text-muted-foreground">Database</dt>
        <StatusValue
          loading={health.isPending}
          ok={dbOk}
          okText="Connected"
          badText={health.isError ? "Unknown" : "Not responding"}
        />
        <dt className="text-muted-foreground">Version</dt>
        <dd className="text-right font-mono text-[13px]">{health.data?.version ?? "–"}</dd>
        <dt className="text-muted-foreground">Address</dt>
        <dd className="truncate text-right font-mono text-[13px]">{host}</dd>
      </dl>
      {local && (
        <p className="border-t pt-3 text-[13px] text-muted-foreground">
          Reachable from this machine only.
        </p>
      )}
    </Card>
  );
}

function StatusValue(props: { loading: boolean; ok: boolean; okText: string; badText: string }) {
  if (props.loading) return <dd className="text-right text-muted-foreground">Checking…</dd>;
  return (
    <dd className="flex items-center justify-end gap-2">
      <span
        aria-hidden
        className={cn("size-2 rounded-full", props.ok ? "bg-success" : "bg-destructive")}
      />
      {props.ok ? props.okText : props.badText}
    </dd>
  );
}
