import { useAgents, useApprovals, useHealth } from "@ofa/client";
import type { SessionResponse } from "@ofa/contracts";
import { Link, useMatches, useNavigate, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/brand-mark";
import { CommandPalette } from "@/components/command-palette";
import { ConversationList } from "@/components/conversation-list";
import { NewChatMenu } from "@/components/new-chat-menu";
import { Toaster } from "@/components/toaster";
import { PopoverPanel, useDismiss } from "@/components/ui/popover";
import { useWorkspaceCounts, WorkspaceMenuItems, WorkspaceNav } from "@/components/workspace-menu";
import { useAgentMoods } from "@/lib/agents";
import { isWorkspacePath } from "@/lib/conversations";
import { useApprovalAlerts } from "@/lib/notifications";
import { isTyping, MOD_K, useGlobalShortcuts, useStoredFlag } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

// The signed-in layout (ADR-0052): conversation first. On wide screens a
// sidebar lists the conversations, or the workspace's sections on those
// pages, with the person's menu at the bottom; `[` hides it. On phones the
// conversation list is the home screen and each page has a slim top bar. The
// ⌘K palette reaches everything. Pages that set `fullBleed` (the chats) fill
// the space and scroll on their own.

export function AppShell({ session, children }: { session: SessionResponse; children: ReactNode }) {
  const matches = useMatches();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const fullBleed = matches.some((m) => m.staticData.fullBleed);
  const title = [...matches].reverse().find((m) => m.staticData.title)?.staticData.title;
  const [hidden, setHidden] = useStoredFlag("ofa-sidebar-hidden", false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const openPalette = (query = "") => {
    setPaletteQuery(query);
    setPaletteOpen(true);
  };
  const { data: agents } = useAgents();
  const moods = useAgentMoods(agents);
  const { data: approvals } = useApprovals();
  const stuck = (agents ?? []).filter((a) => moods.get(a.id)?.mood === "error").length;
  const waiting = approvals?.length ?? 0;
  useApprovalAlerts(agents);

  useGlobalShortcuts({
    openPalette: () => openPalette(),
    toggleSidebar: () => setHidden(!hidden),
    go: (to) => void navigate({ to }),
  });

  // "Keyboard shortcuts" in the menu, and "?" anywhere, open the list.
  useEffect(() => {
    const show = () => openPalette("?");
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "?" && !isTyping(event.target)) show();
    };
    window.addEventListener("ofa:shortcuts", show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("ofa:shortcuts", show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // The tab title counts what needs someone, so it shows from another tab too.
  useEffect(() => {
    const needs = stuck + waiting;
    document.title = `${needs ? `(${needs}) ` : ""}${title ? `${title} · ` : ""}One-for-All`;
  }, [stuck, waiting, title]);

  return (
    <div className="flex h-dvh overflow-hidden">
      {!hidden && (
        <Sidebar
          session={session}
          workspace={isWorkspacePath(pathname)}
          onHide={() => setHidden(true)}
          onSearch={() => openPalette()}
        />
      )}
      {hidden && (
        <button
          type="button"
          onClick={() => setHidden(false)}
          aria-label="Show the sidebar"
          title="Show the sidebar  ["
          className="press fixed top-3 left-3 z-40 hidden size-10 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-muted outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary md:flex"
        >
          <PanelLeftOpen className="size-[18px]" aria-hidden />
        </button>
      )}

      <div className={cn("flex min-w-0 flex-1 flex-col", hidden && "md:pl-14")}>
        <HealthBanner />
        {!fullBleed && (
          <MobileTopBar session={session} title={title} onSearch={() => openPalette()} />
        )}
        <main
          id="main"
          data-scroll-restoration-id="main"
          className={cn("min-h-0 flex-1", fullBleed ? "overflow-hidden" : "overflow-y-auto")}
        >
          {fullBleed ? (
            children
          ) : (
            <div className="mx-auto w-full max-w-[1200px] px-4 pt-2 pb-16 md:px-8 md:pt-8 md:pb-12">
              {children}
            </div>
          )}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        agents={agents ?? []}
        onToggleSidebar={() => setHidden(!hidden)}
        initialQuery={paletteQuery}
      />
      <Toaster raised={false} />
    </div>
  );
}

/** Only when something is wrong: a healthy server needs no banner. */
function HealthBanner() {
  const health = useHealth();
  if (health.isPending || (health.data?.status === "ok" && !health.isError)) return null;
  const message = health.isError
    ? "Can't reach the server. Retrying every 30 seconds…"
    : health.data?.checks.database !== "ok"
      ? "The server can't reach its database. Agents can't run until it's back."
      : "The server is having trouble. Some things may not work.";
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-foreground md:px-6"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
      {message}
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar(props: {
  session: SessionResponse;
  /** On the workspace's pages it lists their sections instead of the chats. */
  workspace: boolean;
  onHide: () => void;
  onSearch: () => void;
}) {
  return (
    <aside
      aria-label="Sidebar"
      className="hidden h-dvh w-[264px] shrink-0 lg:w-[300px] flex-col gap-3 border-r border-sidebar-border bg-sidebar px-3 pt-4 pb-3 text-sidebar-foreground md:flex"
    >
      <div className="flex items-center gap-1 pl-2">
        <Link
          to="/"
          aria-label="One-for-All, your chats"
          className="mr-auto rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Wordmark />
        </Link>
        <NewChatMenu />
        <button
          type="button"
          onClick={props.onHide}
          aria-label="Hide the sidebar"
          title="Hide the sidebar  ["
          className="press flex size-9 items-center justify-center rounded-full text-sidebar-muted outline-none hover:bg-white/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          <PanelLeftClose className="size-[18px]" aria-hidden />
        </button>
      </div>

      <button
        type="button"
        onClick={props.onSearch}
        aria-label={`Search or jump to, ${MOD_K}`}
        className="flex h-10 shrink-0 items-center gap-2.5 rounded-[12px] border border-sidebar-border bg-white/[0.03] px-3 text-sm text-sidebar-muted outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="truncate">Search</span>
        <kbd className="ml-auto rounded-[6px] border border-sidebar-border px-1.5 font-mono text-[11px] whitespace-nowrap">
          {MOD_K}
        </kbd>
      </button>

      <div className="-mx-1 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pt-1">
        {props.workspace ? <WorkspaceNav /> : <ConversationList />}
      </div>

      <AccountButton session={props.session} />
    </aside>
  );
}

function UserInitial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-[#b7a6ff] font-display font-extrabold text-[#0e0e0f]",
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** The person, at the bottom of the sidebar; opens the Workspace menu. */
function AccountButton({ session }: { session: SessionResponse }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const counts = useWorkspaceCounts();
  const needs = Object.keys(counts).length > 0;
  return (
    <div ref={ref} className="relative border-t border-sidebar-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Workspace and account: ${session.user.name}${needs ? ", something needs you" : ""}`}
        onClick={() => setOpen(!open)}
        className="press flex w-full items-center gap-2.5 rounded-[12px] p-1.5 text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span className="relative">
          <UserInitial name={session.user.name} className="size-9 rounded-[12px] text-[15px]" />
          {needs && (
            <span
              aria-hidden
              className="pip-in absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-sidebar"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold">{session.user.name}</span>
          <span className="truncate text-xs text-sidebar-muted">
            {session.workspace?.name ?? session.user.email}
          </span>
        </span>
        <ChevronsUpDown className="size-4 text-sidebar-muted" aria-hidden />
      </button>
      {open && (
        <PopoverPanel place="above-start" label="Workspace" className="w-[276px]">
          <WorkspaceMenuItems session={session} onClose={close} />
        </PopoverPanel>
      )}
    </div>
  );
}

// ── Phone ────────────────────────────────────────────────────────────────────

/** A slim bar on pages that aren't a chat: the menu, the page's name, search. */
function MobileTopBar({
  session,
  title,
  onSearch,
}: {
  session: SessionResponse;
  title: string | undefined;
  onSearch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const counts = useWorkspaceCounts();
  const needs = Object.keys(counts).length > 0;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1 md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="workspace-sheet"
        aria-label={`Workspace and account${needs ? ", something needs you" : ""}`}
        onClick={() => setOpen(true)}
        className="press relative flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <UserInitial name={session.user.name} className="size-[34px] rounded-full text-[15px]" />
        {needs && (
          <span
            aria-hidden
            className="absolute top-1 right-1 size-2.5 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </button>
      {/* Other pages carry their own heading; the list's is the bar's. */}
      <span className="min-w-0 flex-1 truncate font-display text-[19px] font-bold">
        {title === "Chats" ? title : null}
      </span>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        className="press flex size-11 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="size-[19px]" aria-hidden />
      </button>
      <NewChatMenu className="[&>button]:size-11 [&>button]:text-foreground" />

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/55"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            id="workspace-sheet"
            role="menu"
            aria-label="Workspace"
            className="menu-pop flex max-h-[85dvh] w-full origin-bottom flex-col gap-0.5 overflow-y-auto rounded-t-[24px] border-t bg-popover p-2 pb-[max(env(safe-area-inset-bottom),12px)] text-popover-foreground"
          >
            <span aria-hidden className="mx-auto mb-1 h-1 w-10 rounded-full bg-border" />
            <WorkspaceMenuItems session={session} onClose={close} />
          </div>
        </div>
      )}
    </div>
  );
}
