import type { ReactNode } from "react";
import { Familiar } from "@/components/familiar";
import { bySlug, CHIEF } from "@/lib/team";

// Pieces of the real interface, rebuilt at true size with the app's own labels.
// They are the site's pictures: software shows itself, never a stock photo.
// Each root carries `data-ui`, the product's own borders and chrome.

const inbox = bySlug.get("inbox")!;

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-ui
      className={`rounded-[18px] border border-border bg-card text-[13.5px] leading-snug text-foreground ${className}`}
    >
      {children}
    </div>
  );
}

function Who({ name, slug, size = 22 }: { name: string; slug: string; size?: number }) {
  const look = slug === CHIEF.slug ? CHIEF.look : bySlug.get(slug)?.look;
  return (
    <span className="flex items-center gap-2">
      {look && <Familiar look={look} size={size} />}
      <span className="font-semibold">{name}</span>
    </span>
  );
}

/** A draft card waiting for the person: the lime "needs you" moment. */
export function DraftCard({ pulse = true }: { pulse?: boolean }) {
  return (
    <Panel className={`flex flex-col gap-3 border-primary/60 p-4 ${pulse ? "needs-you" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <Who name={inbox.name} slug="inbox" />
        <span className="rounded-full bg-primary px-2.5 py-0.5 text-[12px] font-semibold text-primary-foreground">
          Needs you
        </span>
      </div>
      <p className="text-muted-foreground">Wants to save a Gmail draft</p>
      <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1 rounded-[12px] bg-background px-3 py-2.5 text-[13px]">
        <dt className="text-muted-foreground">To</dt>
        <dd>you@example.com</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd>Laptop pick for Thursday</dd>
        <dt className="text-muted-foreground">Body</dt>
        <dd className="line-clamp-2">
          The ThinkPad T14 Gen 5 at $1,099: 32 GB, Linux-friendly, the best keyboard of the three.
        </dd>
      </dl>
      <div className="flex gap-2">
        <span className="rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-foreground">
          Approve
        </span>
        <span className="rounded-full border border-input px-3.5 py-1.5 text-[13px]">Edit</span>
        <span className="rounded-full px-3 py-1.5 text-[13px] text-muted-foreground">Deny</span>
      </div>
    </Panel>
  );
}

/** The chief's plan, an owner on every item. */
export function PlanFragment() {
  const items: [string, string, boolean][] = [
    ["researcher", "compare laptops under $1,200", true],
    ["operator", "write the report and the sheet", true],
    ["inbox", "draft the recommendation", false],
    ["me", "send you the report file", false],
  ];
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <Who name={CHIEF.name} slug={CHIEF.slug} />
        <span className="text-[12px] text-muted-foreground">Updated the plan</span>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map(([who, text, done]) => (
          <li key={text} className="flex items-start gap-2.5">
            <span
              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${
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
              <span className="text-primary">[{who}]</span> {text}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** A stop that says where it got to, then "continue" from the chat record. */
export function ContinueFragment() {
  return (
    <div data-ui className="flex flex-col gap-3 text-[13.5px] leading-snug text-foreground">
      <div className="rounded-[6px_22px_22px_22px] bg-card px-4 py-3">
        <p>I stopped before finishing: I reached my token budget for one task.</p>
        <p className="mt-2 text-muted-foreground">
          Done so far: the comparison and the report. Still to do: the Gmail draft.
        </p>
      </div>
      <p className="self-end rounded-[22px_22px_6px_22px] bg-primary px-4 py-2 text-primary-foreground">
        continue
      </p>
      <div className="rounded-[14px] border border-dashed border-input bg-card px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
        <span className="text-foreground">Earlier in this chat:</span> asked Researcher → done ·
        operator wrote laptops.xlsx · 9 searches, 6 pages read
      </div>
    </div>
  );
}

/** The operator's own desktop, as the person watches it. */
export function DesktopFragment() {
  return (
    <div data-ui className="overflow-hidden rounded-[14px] border border-border bg-[#20242b]">
      <div className="flex items-center gap-2 bg-[#2b3039] px-3 py-1.5 text-[11.5px] text-[#c9cdd3]">
        <span className="size-2 rounded-full bg-[#ff5b3a]" aria-hidden />
        <span className="size-2 rounded-full bg-[#ffc93a]" aria-hidden />
        <span className="size-2 rounded-full bg-[#6fe39a]" aria-hidden />
        <span className="ml-2">operator@computer: ~/workspace/reports</span>
      </div>
      <pre className="m-0 px-3.5 py-3 font-mono text-[12px] leading-relaxed text-[#e8e8e3]">
        <code>
          <span className="text-[#6fe39a]">$</span> python make_sheet.py{"\n"}
          wrote 3 rows to laptops.xlsx{"\n"}
          <span className="text-[#6fe39a]">$</span> ls{"\n"}
          laptop_report.md laptops.xlsx{"\n"}
          <span className="text-[#6fe39a]">$</span> <span className="caret">▌</span>
        </code>
      </pre>
      <div className="flex items-center justify-between bg-[#161a20] px-3 py-1.5 text-[11px] text-[#8a8a90]">
        <span>Terminal · Files · Mousepad · Gnumeric</span>
        <span>You are watching</span>
      </div>
    </div>
  );
}

/** A routine on a clock, and a quiet check that found nothing. */
export function RoutineFragment() {
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">Morning inbox sweep</span>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[12px]">On</span>
      </div>
      <p className="text-muted-foreground">Weekdays at 07:30 · your time zone</p>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        <li className="flex justify-between">
          <span>Today 07:30</span>
          <span className="text-success">Posted 2 things that need you</span>
        </li>
        <li className="flex justify-between">
          <span>Yesterday 07:30</span>
          <span className="text-muted-foreground">Nothing to report</span>
        </li>
      </ul>
    </Panel>
  );
}

/** What it learned, waiting for a person to confirm. */
export function MemoryFragment() {
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <span className="text-[12px] text-muted-foreground">To confirm · 2</span>
      {["Prefers Linux-friendly laptops", "Budget for work hardware is about $1,200"].map((f) => (
        <div key={f} className="flex items-center justify-between gap-3">
          <span>{f}</span>
          <span className="flex shrink-0 gap-1.5 text-[12px]">
            <span className="rounded-full bg-primary px-2.5 py-0.5 font-semibold text-primary-foreground">
              Keep
            </span>
            <span className="rounded-full border border-input px-2.5 py-0.5">Forget</span>
          </span>
        </div>
      ))}
      <div className="rounded-[12px] bg-background px-3 py-2 text-[12.5px] text-muted-foreground">
        <span className="text-foreground">/weekly-report</span> · a skill: 5 steps, saved by Writer
      </div>
    </Panel>
  );
}

/** Where it runs. */
export function MachineFragment() {
  const rows: [string, string][] = [
    ["Listens on", "127.0.0.1:3000 only"],
    ["Memory", "about 3 GB with agents at work"],
    ["Chips", "x86-64 and arm64"],
    ["Runs on", "a spare laptop, a Mac mini, a Raspberry Pi 5"],
    ["Models", "your OpenRouter key: free models work"],
  ];
  return (
    <Panel className="p-4">
      <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
