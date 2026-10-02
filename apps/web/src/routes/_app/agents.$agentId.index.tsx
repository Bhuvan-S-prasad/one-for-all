import {
  moodFor,
  useAgent,
  useAgentThread,
  useRun,
  useRuns,
  useSendMessage,
  useStopRun,
  useThreadMessages,
  useUpdateAgent,
} from "@ofa/client";
import { FAMILIAR_COLORS, type Agent, type Message, type Run } from "@ofa/contracts";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUp, Check, CircleSlash, Pause, Pencil, Play, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Familiar } from "@/components/familiar";
import { MoodPill } from "@/components/mood-pill";
import { RichText } from "@/components/rich-text";
import { ErrorAlert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MOOD_SENTENCES, serialFor } from "@/lib/agents";
import { duration } from "@/lib/format";
import { runSteps } from "@/lib/run-steps";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/agents/$agentId/")({
  staticData: { title: "Chat" },
  component: AgentChatPage,
});

const ACTIVE = new Set(["queued", "running", "waiting"]);

/** Re-render every second while `on`, for live timers. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

function AgentChatPage() {
  const { agentId } = Route.useParams();
  const { data: agent, error } = useAgent(agentId);
  if (error) return <ErrorAlert>{error.message}</ErrorAlert>;
  if (!agent) return <p className="text-muted-foreground">Loading…</p>;
  return <Chat agent={agent} />;
}

function Chat({ agent }: { agent: Agent }) {
  const { data: thread } = useAgentThread(agent.id);
  const { data: messages } = useThreadMessages(thread?.id);
  const { data: runs } = useRuns(agent.id);
  const latest = runs?.[0];
  const { run: liveRun, events } = useRun(latest?.id);
  const run: Run | undefined = liveRun.data ?? latest;
  const active = !!run && ACTIVE.has(run.status);
  const now = useNow(active);
  const mood = moodFor({
    agentStatus: agent.status,
    run,
    lastEvent: events.data?.at(-1) ?? null,
    now,
  });
  const send = useSendMessage(thread?.id);
  const stop = useStopRun();
  const update = useUpdateAgent(agent.id);
  const tint = FAMILIAR_COLORS[agent.spec.avatar.color];
  const elapsed = run?.startedAt && active ? duration(now - Date.parse(run.startedAt)) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <section
        className="bg-dots relative flex flex-col items-center gap-1 overflow-hidden rounded-xl border px-6 pt-5 pb-7 text-center"
        style={{ backgroundColor: `color-mix(in srgb, ${tint} 16%, var(--card))` }}
      >
        <div className="flex w-full items-center justify-between">
          <span className="eyebrow text-xs text-muted-foreground">{serialFor(agent.id)}</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={update.isPending || agent.status === "archived"}
              onClick={() =>
                update.mutate({ status: agent.status === "active" ? "paused" : "active" })
              }
            >
              {agent.status === "active" ? <Pause aria-hidden /> : <Play aria-hidden />}
              {agent.status === "active" ? "Pause" : "Resume"}
            </Button>
            <Link
              to="/agents/$agentId/edit"
              params={{ agentId: agent.id }}
              className="flex h-9 items-center gap-2 rounded-full border border-input px-4 text-sm font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Pencil className="size-4" aria-hidden /> Edit
            </Link>
          </div>
        </div>
        <Familiar
          look={agent.spec.avatar}
          mood={mood}
          size={168}
          ring="transparent"
          label={`${agent.name} familiar, ${mood}`}
        />
        <h2 className="text-[52px] leading-[0.9] font-extrabold tracking-[-0.045em]">
          {agent.name}
        </h2>
        <p className="mt-1.5 mb-3 text-[15px] text-muted-foreground">{agent.spec.job}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <MoodPill mood={mood} suffix={elapsed} />
          <span className="text-sm text-muted-foreground">{MOOD_SENTENCES[mood]}</span>
        </div>
      </section>

      {run &&
        (active ||
          run.status === "failed" ||
          events.data?.some((e) => e.type === "tool.called")) && (
          <CurrentRun
            run={run}
            events={events.data ?? []}
            active={active}
            stopping={stop.isPending}
            onStop={() => stop.mutate(run.id)}
          />
        )}

      <Thread agent={agent} messages={messages ?? []} thinking={active} />

      {send.error && <ErrorAlert>{send.error.message}</ErrorAlert>}
      <Composer
        agent={agent}
        disabled={!thread || agent.status !== "active"}
        sending={send.isPending}
        onSend={(text) => send.mutateAsync(text).then(() => undefined)}
      />
    </div>
  );
}

function CurrentRun(props: {
  run: Run;
  events: Parameters<typeof runSteps>[0];
  active: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const steps = runSteps(props.events);
  return (
    <section
      aria-label="Current run"
      className="flex flex-col gap-3 rounded-lg border bg-card px-5 py-4"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow text-[11px] text-muted-foreground">
          {props.active ? "Current run" : "Last run"}
        </span>
        <div className="flex items-center gap-3">
          <Link
            to="/activity"
            search={{ run: props.run.id }}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Details
          </Link>
          {props.active && (
            <Button size="sm" variant="outline" onClick={props.onStop} disabled={props.stopping}>
              <Square aria-hidden /> Stop
            </Button>
          )}
        </div>
      </div>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {props.active ? "Thinking it over…" : "Answered without using tools."}
        </p>
      ) : (
        <ol className="flex flex-col gap-2.5 text-sm">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-2.5">
              <StepIcon state={step.state} />
              <span className={cn("flex-1", step.state === "active" && "font-semibold")}>
                {step.label}
                {step.detail && (
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {step.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {props.run.status === "failed" && props.run.error && (
        <p className="text-sm text-destructive">Stopped with an error: {props.run.error.message}</p>
      )}
    </section>
  );
}

function StepIcon({ state }: { state: "done" | "active" | "failed" | "blocked" }) {
  const base = "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full";
  if (state === "done")
    return (
      <span className={cn(base, "bg-primary text-primary-foreground")}>
        <Check className="size-3" strokeWidth={3} aria-label="Done" />
      </span>
    );
  if (state === "failed")
    return (
      <span className={cn(base, "bg-destructive-surface text-destructive")}>
        <X className="size-3" strokeWidth={3} aria-label="Failed" />
      </span>
    );
  if (state === "blocked")
    return (
      <span className={cn(base, "bg-warning/15 text-warning")}>
        <CircleSlash className="size-3" strokeWidth={3} aria-label="Not allowed" />
      </span>
    );
  return (
    <span className={cn(base, "border-2 border-info")} aria-label="In progress">
      <span className="size-2 animate-pulse rounded-full bg-info" />
    </span>
  );
}

function Thread({
  agent,
  messages,
  thinking,
}: {
  agent: Agent;
  messages: readonly Message[];
  thinking: boolean;
}) {
  const end = useRef<HTMLDivElement>(null);
  // Block body: newer browsers return a promise from scrollIntoView, and an
  // effect must return nothing or a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, thinking]);
  const visible = messages.filter((m) => m.author.type !== "system");

  return (
    <section aria-label="Conversation" className="flex flex-col gap-3" aria-live="polite">
      {visible.length === 0 && !thinking && (
        <p className="py-6 text-center text-muted-foreground">
          Say hello, or give {agent.name} something to do.
        </p>
      )}
      {visible.map((m) =>
        m.author.type === "user" ? (
          <div
            key={m.id}
            className="max-w-[82%] self-end rounded-[22px_22px_6px_22px] bg-foreground px-4 py-3 text-[15px] leading-snug text-background"
          >
            <p className="whitespace-pre-wrap">{m.content}</p>
          </div>
        ) : (
          <div key={m.id} className="flex max-w-[88%] items-end gap-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent">
              <Familiar
                look={{ ...agent.spec.avatar, mark: "none" }}
                size={32}
                ring="var(--accent)"
              />
            </span>
            <div className="rounded-[22px_22px_22px_6px] bg-card px-4 py-3 text-[15px] leading-snug">
              <RichText text={m.content} />
            </div>
          </div>
        ),
      )}
      {thinking && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            ))}
          </span>
          {agent.name} is working on it
        </div>
      )}
      <div ref={end} />
    </section>
  );
}

function Composer(props: {
  agent: Agent;
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = text.trim();
    if (!content || props.disabled || props.sending) return;
    setText("");
    try {
      await props.onSend(content);
    } catch {
      setText(content); // Keep what they wrote if it didn't send.
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) void submit(event);
  };

  return (
    <form onSubmit={submit} className="sticky bottom-24 flex items-end gap-2 md:bottom-4">
      <label htmlFor="message" className="sr-only">
        Message {props.agent.name}
      </label>
      <textarea
        id="message"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        disabled={props.disabled}
        placeholder={
          props.agent.status === "active"
            ? `Message ${props.agent.name}`
            : `${props.agent.name} is paused`
        }
        className="max-h-40 min-h-13 flex-1 resize-none rounded-[26px] border border-input bg-card px-5 py-3.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
      />
      <Button
        type="submit"
        size="icon"
        className="size-13"
        aria-label="Send"
        disabled={props.disabled || props.sending || !text.trim()}
      >
        <ArrowUp className="!size-5" aria-hidden />
      </Button>
    </form>
  );
}
