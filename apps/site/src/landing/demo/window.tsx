import type { FamiliarLook, FamiliarMood } from "@ofa/contracts";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Familiar } from "@/components/familiar";
import { reducedMotion } from "@/lib/site";
import { bySlug, CHIEF } from "@/lib/team";
import { SupplierScreen } from "./screen";
import {
  CONVERSATIONS,
  NAMES,
  type Beat,
  type Conversation,
  type Screen,
  type Who,
} from "./script";

// The app, rebuilt for the page (ADR-0052's layout): the conversations on the
// left, one chat on the right, and the Operator's computer. The visitor can
// open any conversation, take over the computer, edit a draft and approve.
// Every conversation plays its script once, pausing where a person is needed.

const LOOKS: Record<Who, FamiliarLook> = {
  chief: CHIEF.look,
  operator: bySlug.get("operator")!.look,
  inbox: bySlug.get("inbox")!.look,
  researcher: bySlug.get("researcher")!.look,
  writer: bySlug.get("writer")!.look,
};

type ComputerState = "needs" | "control" | "working" | "done";

interface Progress {
  /** Beats shown so far. */
  readonly cursor: number;
  readonly screen: Screen;
  readonly computer: ComputerState;
  readonly approvals: Readonly<Record<string, "approved" | "denied">>;
  readonly drafts: Readonly<Record<string, string>>;
  readonly opened: boolean;
}

const START: Progress = {
  cursor: 0,
  screen: "login",
  computer: "needs",
  approvals: {},
  drafts: {},
  opened: false,
};

/** How long each beat takes to arrive, as if the agent were working. */
function delayFor(beat: Beat | undefined): number {
  if (!beat) return 0;
  const fast = reducedMotion();
  const ms: Record<Beat["t"], number> = {
    user: 450,
    agent: 1150,
    note: 250,
    steps: 800,
    computer: 650,
    approval: 800,
    plan: 900,
    handoff: 700,
    table: 1300,
    screen: 850,
    gate: 0,
  };
  return fast ? Math.min(ms[beat.t], 200) : ms[beat.t];
}

function Bold({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith("**") ? (
          <strong key={i} className="font-semibold text-foreground">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Fam({ who, size, mood = "idle" }: { who: Who; size: number; mood?: FamiliarMood }) {
  return <Familiar look={LOOKS[who]} size={size} mood={mood} animate={mood !== "idle"} />;
}

function GroupFace({ who, size = 38 }: { who: readonly Who[]; size?: number }) {
  const s = size * 0.62;
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      <span className="absolute top-0 left-[20%]">
        <Familiar look={LOOKS[who[0]!]} size={s} />
      </span>
      <span className="absolute bottom-0 left-0">
        <Familiar look={LOOKS[who[1]!]} size={s} />
      </span>
      <span className="absolute right-0 bottom-0">
        <Familiar look={LOOKS[who[2]!]} size={s} />
      </span>
    </span>
  );
}

// ── The window ───────────────────────────────────────────────────────────────

export function AppWindow() {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(CONVERSATIONS[0]!.id);
  const [progress, setProgress] = useState<Record<string, Progress>>(() =>
    Object.fromEntries(CONVERSATIONS.map((c) => [c.id, { ...START, opened: c.id === "operator" }])),
  );
  const [started, setStarted] = useState(false);
  const [phoneChat, setPhoneChat] = useState(false);
  // Wide screens watch the Operator's computer beside the chat, as in the app.
  const [panel, setPanel] = useState(true);
  const conversation = CONVERSATIONS.find((c) => c.id === active)!;
  const p = progress[active]!;

  // Starts playing when the window comes into view.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setStarted(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const update = useCallback(
    (id: string, change: (p: Progress) => Partial<Progress>) =>
      setProgress((all) => ({ ...all, [id]: { ...all[id]!, ...change(all[id]!) } })),
    [],
  );

  // The player: shows the next beat after its delay, and stops at a gate.
  const next = conversation.beats[p.cursor];
  useEffect(() => {
    if (!started || !next || next.t === "gate") return;
    const id = conversation.id;
    const timer = setTimeout(() => {
      update(id, (q) => {
        if (next.t === "screen") {
          // A declined order never reaches the confirmation page.
          if (next.screen === "placed" && q.approvals.order !== "approved") {
            return { cursor: q.cursor + 1, computer: "done" };
          }
          return {
            cursor: q.cursor + 1,
            screen: next.screen,
            computer: next.screen === "placed" ? "done" : q.computer,
          };
        }
        return { cursor: q.cursor + 1 };
      });
    }, delayFor(next));
    return () => clearTimeout(timer);
  }, [started, next, conversation.id, update]);

  const pass = (change: (p: Progress) => Partial<Progress> = () => ({})) =>
    update(active, (q) => ({ ...change(q), cursor: q.cursor + 1 }));

  const open = (id: string) => {
    setActive(id);
    setPhoneChat(true);
    update(id, () => ({ opened: true }));
  };

  const waiting = next?.t === "gate" ? next : null;
  const typing = started && next?.t === "agent" ? next.who : null;

  return (
    <div
      ref={root}
      data-demo-window
      className="relative mx-auto flex h-[min(680px,82svh)] w-full max-w-[1180px] overflow-hidden rounded-[22px] border border-white/10 bg-background text-left shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]"
    >
      {/* Conversations */}
      <aside
        aria-label="Conversations"
        className={`w-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex md:w-[272px] ${
          phoneChat ? "hidden" : "flex"
        }`}
      >
        <div className="flex h-12 items-center gap-1.5 px-4">
          <span className="size-3 rounded-full bg-[#ff5f57]" aria-hidden />
          <span className="size-3 rounded-full bg-[#febc2e]" aria-hidden />
          <span className="size-3 rounded-full bg-[#28c840]" aria-hidden />
          <span className="ml-auto text-[18px] leading-none text-sidebar-muted" aria-hidden>
            +
          </span>
        </div>
        <div className="mx-3 mb-2 flex h-9 items-center gap-2 rounded-[11px] border border-sidebar-border bg-white/[0.03] px-3 text-[13px] text-sidebar-muted">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          Search
        </div>
        <ul
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2"
          data-lenis-prevent
        >
          {CONVERSATIONS.map((c) => (
            <li key={c.id}>
              <Row c={c} p={progress[c.id]!} current={c.id === active} onOpen={() => open(c.id)} />
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2.5 border-t border-sidebar-border px-4 py-3">
          <span className="flex size-8 items-center justify-center rounded-[10px] bg-[#b7a6ff] font-display text-[13px] font-extrabold text-[#0e0e0f]">
            M
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold text-sidebar-foreground">Maya Ortiz</span>
            <span className="text-[11.5px] text-sidebar-muted">Kestrel Coffee Roasters</span>
          </span>
        </div>
      </aside>

      {/* The chat */}
      <section
        aria-label={`Chat: ${conversation.name}`}
        className={`min-w-0 flex-1 flex-col md:flex ${phoneChat ? "flex" : "hidden"}`}
      >
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-3 md:px-5">
          <button
            type="button"
            onClick={() => setPhoneChat(false)}
            aria-label="Back to conversations"
            className="flex size-9 items-center justify-center rounded-full hover:bg-accent md:hidden"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          {conversation.kind === "group" ? (
            <GroupFace who={conversation.who} size={32} />
          ) : (
            <Fam who={conversation.who[0]!} size={30} mood={typing ? "working" : "idle"} />
          )}
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[15px] font-semibold">{conversation.name}</span>
            {typing ? (
              <span className="text-[11.5px] text-highlight">Working…</span>
            ) : conversation.kind === "group" ? (
              <span className="truncate text-[11.5px] text-muted-foreground">
                {conversation.who.map((w) => NAMES[w]).join(" · ")}
              </span>
            ) : null}
          </span>
          {conversation.id === "operator" && (
            <button
              type="button"
              onClick={() => setPanel(!panel)}
              aria-pressed={panel}
              aria-label={panel ? "Hide the Operator's screen" : "Show the Operator's screen"}
              className={`ml-auto hidden size-9 items-center justify-center rounded-full hover:bg-accent xl:flex ${
                panel ? "bg-accent text-foreground" : "text-muted-foreground"
              }`}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M8 20h8M12 16v4" />
              </svg>
            </button>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Messages
              conversation={conversation}
              p={p}
              typing={typing}
              waiting={waiting}
              onTakeOver={() => pass(() => ({ computer: "control" }))}
              onDone={() => pass(() => ({ computer: "working" }))}
              onDecide={(id, answer) =>
                pass((q) => ({ approvals: { ...q.approvals, [id]: answer } }))
              }
              onDraft={(id, text) =>
                update(active, (q) => ({ drafts: { ...q.drafts, [id]: text } }))
              }
              onOpenOperator={() => open("operator")}
              shownKey={phoneChat ? "chat" : "list"}
            />
            <Composer
              name={conversation.name}
              chips={waiting?.until === "chip" ? (waiting.chips ?? []) : []}
              onChip={() => pass()}
            />
          </div>
          {panel && conversation.id === "operator" && (
            <aside
              aria-label="The Operator's computer"
              className="hidden w-[min(360px,32%)] shrink-0 flex-col gap-3 border-l border-border bg-[#141416] p-4 xl:flex"
            >
              <SupplierScreen screen={p.screen} />
              <span className="text-center text-[12px] text-muted-foreground">
                Operator's screen · live
              </span>
              <span className="mt-4 text-[12px] font-semibold text-muted-foreground">Routines</span>
              <span className="flex items-center gap-2 text-[13px]">
                <span className="size-2 rounded-full bg-warning" aria-hidden />
                Green coffee stock check
                <span className="ml-auto text-[12px] text-muted-foreground">Mon 08:00</span>
              </span>
              <span className="flex items-center gap-2 text-[13px]">
                <span className="size-2 rounded-full bg-success" aria-hidden />
                Reorder when under 2 sacks
                <span className="ml-auto text-[12px] text-muted-foreground">check</span>
              </span>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Sidebar row ──────────────────────────────────────────────────────────────

function lastLine(c: Conversation, p: Progress): string {
  for (let i = p.cursor - 1; i >= 0; i--) {
    const b = c.beats[i]!;
    if (b.t === "agent")
      return (c.kind === "group" ? `${NAMES[b.who]}: ` : "") + b.text.replace(/\*\*/g, "");
    if (b.t === "user") return `You: ${b.text}`;
    if (b.t === "gate" && b.until === "chip") return `You: ${b.chips?.[0] ?? ""}`;
  }
  return c.preview;
}

function Row({
  c,
  p,
  current,
  onOpen,
}: {
  c: Conversation;
  p: Progress;
  current: boolean;
  onOpen: () => void;
}) {
  const gate = c.beats[p.cursor];
  const needs =
    c.state === "needs" && (gate?.t === "gate" ? gate.until !== "chip" : p.cursor === 0);
  const unread = !p.opened && c.unread ? c.unread : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current ? "true" : undefined}
      className={`flex h-[60px] w-full items-center gap-2.5 rounded-[13px] px-2 text-left transition-[background-color,transform] duration-150 active:scale-[0.98] ${
        current ? "bg-white/[0.08]" : "hover:bg-white/[0.04]"
      }`}
    >
      {c.kind === "group" ? (
        <GroupFace who={c.who} />
      ) : (
        <span className="shrink-0">
          <Fam who={c.who[0]!} size={38} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[14px] ${needs || unread ? "font-bold" : "font-semibold"} text-sidebar-foreground`}
          >
            {c.name}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-sidebar-muted">{c.time}</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-sidebar-muted">
            {lastLine(c, p)}
          </span>
          {needs ? (
            <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] leading-[17px] font-bold text-primary-foreground">
              Needs you
            </span>
          ) : unread ? (
            <span className="flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-info px-1 font-mono text-[10px] font-semibold text-background">
              {unread}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

// ── Messages ─────────────────────────────────────────────────────────────────

function Messages(props: {
  conversation: Conversation;
  p: Progress;
  typing: Who | null;
  waiting: Extract<Beat, { t: "gate" }> | null;
  onTakeOver: () => void;
  onDone: () => void;
  onDecide: (id: string, answer: "approved" | "denied") => void;
  onDraft: (id: string, text: string) => void;
  onOpenOperator: () => void;
  /** Changes when the chat comes on screen (phones show list or chat). */
  shownKey: string;
}) {
  const { conversation: c, p, waiting } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const shown = c.beats.slice(0, p.cursor);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [p.cursor, props.typing, c.id, p.computer, p.approvals, props.shownKey]);

  return (
    <div
      ref={scroller}
      data-lenis-prevent
      className="min-h-0 flex-1 overflow-y-auto px-3 py-5 md:px-7"
    >
      <div className="mx-auto flex max-w-[640px] flex-col gap-3.5">
        {shown.map((beat, i) => (
          <BeatView
            key={`${c.id}-${i}`}
            {...props}
            beat={beat}
            index={i}
            c={c}
            gateOpen={waiting}
          />
        ))}
        {props.typing && (
          <div
            className="flex items-center gap-2 text-[13px] text-muted-foreground"
            aria-live="polite"
          >
            {c.kind === "group" && <Fam who={props.typing} size={20} mood="thinking" />}
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
                  style={{ animationDelay: `${d * 160}ms` }}
                />
              ))}
            </span>
            <span className="sr-only">{NAMES[props.typing]} is writing</span>
          </div>
        )}
        {c.id === "chief" && p.cursor >= 2 && (
          <button
            type="button"
            onClick={props.onOpenOperator}
            className="self-start rounded-full border border-input px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Open the Operator's chat →
          </button>
        )}
      </div>
    </div>
  );
}

function AgentLine({ who, c, children }: { who: Who; c: Conversation; children: ReactNode }) {
  return (
    <div className="demo-in flex max-w-[92%] flex-col gap-1.5 text-[14px] leading-relaxed text-foreground/90">
      {c.kind === "group" && (
        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
          <Fam who={who} size={20} />
          {NAMES[who]}
        </span>
      )}
      {children}
    </div>
  );
}

function BeatView(props: {
  beat: Beat;
  /** Its place in the script, so a plan can tick off what came after it. */
  index: number;
  c: Conversation;
  p: Progress;
  gateOpen: Extract<Beat, { t: "gate" }> | null;
  onTakeOver: () => void;
  onDone: () => void;
  onDecide: (id: string, answer: "approved" | "denied") => void;
  onDraft: (id: string, text: string) => void;
}) {
  const { beat, c, p } = props;
  switch (beat.t) {
    case "user":
      return <UserBubble text={beat.text} />;
    case "gate":
      return beat.until === "chip" && beat.chips?.[0] ? <UserBubble text={beat.chips[0]} /> : null;
    case "agent":
      return (
        <AgentLine who={beat.who} c={c}>
          <p>
            <Bold text={beat.text} />
          </p>
        </AgentLine>
      );
    case "note":
      return <p className="demo-in text-center text-[12px] text-muted-foreground">{beat.text}</p>;
    case "steps":
      return (
        <ul className="demo-in flex max-w-[92%] flex-col gap-1 rounded-[14px] border border-border bg-card/60 px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
          {beat.items.map((s) => (
            <li key={s} className="flex items-start gap-2">
              <span className="text-success" aria-hidden>
                ✓
              </span>
              {s}
            </li>
          ))}
        </ul>
      );
    case "screen":
      return null;
    case "handoff":
      return (
        <p className="demo-in flex items-center gap-2 self-start rounded-full border border-dashed border-input px-3 py-1 text-[12px] text-muted-foreground">
          <Fam who="chief" size={16} />→<Fam who={beat.to} size={16} />
          {beat.text}
        </p>
      );
    case "plan":
      return (
        <div className="demo-in flex max-w-[92%] flex-col gap-2 rounded-[16px] border border-border bg-card px-4 py-3 text-[13px]">
          <span className="text-[12px] text-muted-foreground">Plan</span>
          {beat.items.map(([who, text]) => {
            // Ticked once that teammate has reported back; "me" when the script ends.
            const after = c.beats.slice(props.index + 1, p.cursor);
            const done =
              who === "me"
                ? p.cursor >= c.beats.length && after.length > 0
                : after.some((b) => b.t === "agent" && b.who === who);
            return (
              <span key={text} className="flex items-start gap-2.5">
                <span
                  className={`mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-300 ${
                    done ? "border-primary bg-primary text-primary-foreground" : "border-input"
                  }`}
                  aria-hidden
                >
                  {done && (
                    <svg viewBox="0 0 12 12" className="size-2.5">
                      <path
                        d="M2.5 6.2 5 8.5l4.5-5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span className={done ? "text-muted-foreground line-through" : ""}>
                  <span className="text-primary">[{who === "me" ? "me" : NAMES[who]}]</span> {text}
                  <span className="sr-only">{done ? " (done)" : ""}</span>
                </span>
              </span>
            );
          })}
        </div>
      );
    case "table":
      return (
        <AgentLine who={beat.who} c={c}>
          <div className="overflow-x-auto rounded-[14px] border border-border">
            <table className="w-full text-[12.5px]">
              <thead className="bg-card text-left text-muted-foreground">
                <tr>
                  {beat.head.map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {beat.rows.map((r) => (
                  <tr key={r[0]} className="border-t border-border">
                    {r.map((cell, j) => (
                      <td
                        key={j}
                        className={`px-3 py-1.5 ${r[0] === "Kestrel" ? "text-highlight" : ""}`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="flex flex-wrap gap-1.5">
            {beat.sources.map((s, i) => (
              <span
                key={s}
                className="rounded-full bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {i + 1} · {s}
              </span>
            ))}
          </span>
        </AgentLine>
      );
    case "computer":
      return (
        <ComputerCard
          ask={beat.ask}
          p={p}
          gate={props.gateOpen}
          onTakeOver={props.onTakeOver}
          onDone={props.onDone}
        />
      );
    case "approval":
      return (
        <ApprovalCard
          beat={beat}
          state={p.approvals[beat.id]}
          draft={p.drafts[beat.id] ?? beat.draft}
          open={props.gateOpen?.until === `approve:${beat.id}`}
          onDecide={(a) => props.onDecide(beat.id, a)}
          onDraft={(t) => props.onDraft(beat.id, t)}
        />
      );
  }
}

function UserBubble({ text }: { text: string }) {
  return (
    <p className="demo-in max-w-[82%] self-end rounded-[20px_20px_6px_20px] bg-[#ecebe5] px-4 py-2.5 text-[14px] leading-snug text-[#141415]">
      {text}
    </p>
  );
}

// ── The computer card: the moment Grok-style apps are known for ─────────────

const COMPUTER_BADGE: Record<ComputerState, { label: string; tone: string }> = {
  needs: { label: "Action needed", tone: "bg-warning/15 text-warning" },
  control: { label: "You're in control", tone: "bg-primary/15 text-highlight" },
  working: { label: "Working", tone: "bg-info/15 text-info" },
  done: { label: "Done", tone: "bg-success/15 text-success" },
};

function ComputerCard(props: {
  ask: string;
  p: Progress;
  gate: Extract<Beat, { t: "gate" }> | null;
  onTakeOver: () => void;
  onDone: () => void;
}) {
  const { p, gate } = props;
  const badge = COMPUTER_BADGE[p.computer];
  const canTake = gate?.until === "takeover";
  const canFinish = gate?.until === "done";
  // A "You" pointer shows where to press if the visitor hasn't yet: it
  // belongs to the button that is waiting, so it goes when that one is pressed.
  const waitingFor = canTake ? "takeover" : canFinish ? "done" : null;
  const [hintFor, setHintFor] = useState<string | null>(null);
  useEffect(() => {
    if (!waitingFor) return;
    const t = setTimeout(() => setHintFor(waitingFor), waitingFor === "done" ? 3200 : 1600);
    return () => clearTimeout(t);
  }, [waitingFor]);
  const hint = waitingFor !== null && hintFor === waitingFor;

  return (
    <div className="demo-in flex max-w-[560px] flex-col gap-3 rounded-[20px] border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-semibold">Computer</span>
        <span
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium ${badge.tone}`}
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full bg-current ${p.computer === "needs" ? "animate-pulse" : ""}`}
          />
          {badge.label}
        </span>
      </div>
      <p className="text-[14px] text-foreground/90">{props.ask}</p>
      <SupplierScreen screen={p.screen} />
      {(canTake || canFinish) && (
        <div className="relative flex gap-2">
          <button
            type="button"
            onClick={props.onTakeOver}
            disabled={!canTake}
            className={`rounded-full px-4 py-2 text-[13.5px] font-semibold transition-transform duration-150 active:scale-[0.97] ${
              canTake
                ? "bg-[#f4f4f0] text-[#0e0e0f] hover:bg-white"
                : "bg-white/10 text-muted-foreground"
            }`}
          >
            Take over
          </button>
          <button
            type="button"
            onClick={props.onDone}
            disabled={!canFinish}
            className={`rounded-full px-4 py-2 text-[13.5px] font-semibold transition-transform duration-150 active:scale-[0.97] ${
              canFinish
                ? "bg-[#f4f4f0] text-[#0e0e0f] hover:bg-white"
                : "border border-input text-muted-foreground"
            }`}
          >
            I'm done
          </button>
          {hint && (
            <span
              aria-hidden
              className="demo-hint pointer-events-none absolute top-6"
              style={{ left: canFinish ? 150 : 52 }}
            >
              <svg width="18" height="22" viewBox="0 0 14 18">
                <path
                  d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z"
                  fill="#0e0e0f"
                  stroke="#fff"
                  strokeWidth="1.2"
                />
              </svg>
              <span className="ml-3 rounded-[6px] bg-[#0e0e0f] px-1.5 py-0.5 text-[10.5px] font-semibold text-white ring-1 ring-white/30">
                You
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────

function ApprovalCard(props: {
  beat: Extract<Beat, { t: "approval" }>;
  state: "approved" | "denied" | undefined;
  draft: string | undefined;
  open: boolean;
  onDecide: (answer: "approved" | "denied") => void;
  onDraft: (text: string) => void;
}) {
  const { beat, state, open } = props;
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div
        className={`demo-in flex max-w-[560px] flex-col gap-3 rounded-[20px] border bg-card p-4 ${
          open ? "needs-you border-primary/60" : "border-border"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[14px] font-semibold">
            <Fam who={beat.who} size={22} />
            {beat.title}
          </span>
          {open ? (
            <span className="shrink-0 rounded-full bg-primary px-2.5 py-0.5 text-[11.5px] font-bold text-primary-foreground">
              Needs you
            </span>
          ) : state ? (
            <span
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] ${state === "approved" ? "bg-success/15 text-success" : "bg-accent text-muted-foreground"}`}
            >
              {state === "approved" ? "Approved" : "Denied"}
            </span>
          ) : null}
        </div>
        <dl className="grid grid-cols-[76px_1fr] gap-x-3 gap-y-1 rounded-[12px] bg-background px-3 py-2.5 text-[12.5px]">
          {beat.rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </Fragment>
          ))}
        </dl>
        {props.draft !== undefined &&
          (editing && open ? (
            <textarea
              value={props.draft}
              onChange={(e) => props.onDraft(e.target.value)}
              rows={4}
              aria-label="The reply, editable"
              className="w-full resize-none rounded-[12px] border border-primary/50 bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none"
            />
          ) : (
            <p className="rounded-[12px] bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground/90">
              {props.draft}
            </p>
          ))}
        {open && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => props.onDecide("approved")}
              className="rounded-full bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition-transform duration-150 hover:bg-primary/90 active:scale-[0.97]"
            >
              {editing ? "Save and approve" : "Approve"}
            </button>
            {props.draft !== undefined && (
              <button
                type="button"
                onClick={() => setEditing(!editing)}
                className="rounded-full border border-input px-4 py-2 text-[13px] transition-transform duration-150 hover:bg-accent active:scale-[0.97]"
              >
                {editing ? "Done editing" : "Edit"}
              </button>
            )}
            <button
              type="button"
              onClick={() => props.onDecide("denied")}
              className="rounded-full px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Deny
            </button>
          </div>
        )}
      </div>
      {state && (
        <div className="demo-in max-w-[92%] text-[14px] leading-relaxed text-foreground/90">
          {state === "approved" ? beat.approved : beat.denied}
        </div>
      )}
    </>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────

function Composer({
  name,
  chips,
  onChip,
}: {
  name: string;
  chips: readonly string[];
  onChip: () => void;
}) {
  return (
    <div className="shrink-0 px-3 pb-3 md:px-7 md:pb-5">
      <div className="mx-auto flex max-w-[640px] flex-col gap-2">
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={onChip}
                className="needs-you rounded-full border border-primary/60 bg-primary/10 px-3.5 py-1.5 text-left text-[13px] text-foreground transition-transform duration-150 hover:bg-primary/20 active:scale-[0.97]"
              >
                {chip} <span className="text-highlight">↵</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex h-12 items-center gap-3 rounded-full border border-border bg-card px-4 text-[14px] text-muted-foreground">
          <span className="text-[18px] leading-none" aria-hidden>
            +
          </span>
          <span className="flex-1 truncate">Message {name}</span>
          <span
            className="flex size-8 items-center justify-center rounded-full bg-accent"
            aria-hidden
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
