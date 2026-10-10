import type { Agent } from "@ofa/contracts";
import { Hand, X } from "lucide-react";
import { useEffect, useState } from "react";
import { DesktopView } from "@/components/computer/desktop-view";
import { ScreenView } from "@/components/computer/screen-view";
import { cn } from "@/lib/utils";

// The computer in the chat (M3.10, ADR-0040): a live view of the agent's
// desktop (its browser, terminal, files and documents) beside the
// conversation, and a full-screen takeover for a login or anything the agent
// shouldn't do itself (ADR-0012: passwords, 2FA, payments). If the desktop
// can't be shown, the browser page alone is the fallback.

/** Whether an agent may use a browser at all, from its grants. */
export function usesBrowser(agent: Agent): boolean {
  return agent.grants.some(
    (g) => g.mode !== "blocked" && (g.tool === "browser.*" || g.tool.startsWith("browser.")),
  );
}

const COMPUTER_TOOLS = ["browser.", "desktop.", "files.", "shell."];

/** Whether an agent uses its computer at all: a browser, the shell, files or desktop apps. */
export function usesComputer(agent: Agent): boolean {
  return agent.grants.some(
    (g) => g.mode !== "blocked" && COMPUTER_TOOLS.some((prefix) => g.tool.startsWith(prefix)),
  );
}

/** The desktop, or the browser page alone after the person asks for it. */
function ComputerView({
  agent,
  control,
  onControlRefused,
  className,
}: {
  agent: Agent;
  control: boolean;
  onControlRefused?: () => void;
  className?: string;
}) {
  const [browserOnly, setBrowserOnly] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  if (browserOnly) {
    return (
      <ScreenView
        agent={agent}
        control={control}
        onStatus={({ takenOverByOther }) => {
          if (control && takenOverByOther) onControlRefused?.();
        }}
        className={className}
      />
    );
  }
  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      <DesktopView
        agent={agent}
        control={control}
        onControlRefused={onControlRefused}
        onUnavailable={() => setUnavailable(true)}
        className="min-h-0 flex-1"
      />
      {unavailable && (
        <button
          type="button"
          onClick={() => setBrowserOnly(true)}
          className="self-start text-[12.5px] text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show the browser only
        </button>
      )}
    </div>
  );
}

export function ComputerPanel({
  agent,
  onClose,
  onTakeOver,
}: {
  agent: Agent;
  onClose: () => void;
  onTakeOver: () => void;
}) {
  return (
    <aside
      aria-label={`${agent.name}'s computer`}
      className="hidden w-115 shrink-0 flex-col gap-3 border-l px-4 pt-4 pb-4 lg:flex"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold">Computer</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onTakeOver}
            className="flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Hand className="size-3.5" aria-hidden /> Take over
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide the computer"
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {/* The desktop is 1280×800: keep its shape. */}
      <ComputerView agent={agent} control={false} className="aspect-16/10 w-full" />
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        {`${agent.name}'s computer, live: its browser, terminal and files. Take over to sign in or do something yourself; ${agent.name} waits until you hand it back.`}
      </p>
    </aside>
  );
}

/**
 * Full screen: watching, or in control. Leaving control (or closing) hands
 * the computer back. On phones this is the only view.
 */
export function ComputerOverlay({
  agent,
  initialControl,
  onClose,
}: {
  agent: Agent;
  initialControl: boolean;
  onClose: () => void;
}) {
  const [control, setControl] = useState(initialControl);
  const [refused, setRefused] = useState(false);
  // Escape goes to the desktop while you have control; only the buttons leave.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  const action =
    "flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={control ? `You have ${agent.name}'s computer` : `${agent.name}'s computer`}
      className="fixed inset-0 z-60 flex flex-col gap-3 bg-background p-3 md:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-[16px] font-bold">
            {control ? `You have ${agent.name}'s computer` : `${agent.name}'s computer`}
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            {control
              ? `${agent.name} waits until you hand it back. What you type goes only to the computer; nothing is recorded.`
              : refused
                ? "Someone else has control right now. You can watch."
                : `What ${agent.name}'s computer shows, live.`}
          </span>
        </div>
        <div className="flex gap-2">
          {control ? (
            <button
              type="button"
              onClick={() => setControl(false)}
              className={cn(action, "bg-primary text-primary-foreground hover:bg-primary/85")}
            >
              Hand back to {agent.name}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setRefused(false);
                setControl(true);
              }}
              className={cn(action, "bg-primary text-primary-foreground hover:bg-primary/85")}
            >
              <Hand className="size-4" aria-hidden /> Take over
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={cn(action, "border border-input px-3 hover:bg-accent")}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      <ComputerView
        key={control ? "control" : "watch"}
        agent={agent}
        control={control}
        onControlRefused={() => {
          setRefused(true);
          setControl(false);
        }}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
