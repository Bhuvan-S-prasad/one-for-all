import { useAgents, useApprovals, useHealth } from "@ofa/client";
import type { Agent, FamiliarMood, SessionResponse } from "@ofa/contracts";
import { Link, useMatches, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ChevronsUpDown,
  Ghost,
  House,
  Keyboard,
  LogOut,
  MessageCircle,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark, Wordmark } from "@/components/brand-mark";
import { CommandPalette } from "@/components/command-palette";
import { Familiar } from "@/components/familiar";
import { Toaster } from "@/components/toaster";
import { MOOD_WORDS, shouldAnimate, useAgentMoods } from "@/lib/agents";
import { roleLabel } from "@/lib/format";
import { useApprovalAlerts } from "@/lib/notifications";
import { isTyping, MOD_K, useGlobalShortcuts, useStoredFlag } from "@/lib/shortcuts";
import { setThemePreference, useTheme, type ThemePreference } from "@/lib/theme";
import { useSignOut } from "@/lib/use-sign-out";
import { cn } from "@/lib/utils";

// The signed-in layout (UX.03): a sidebar that folds to an icon rail, with the
// agents in it; a palette on ⌘K / Ctrl K; on phones, a top bar and labelled
// tabs. Pages that set `fullBleed` (the chat) fill the space and scroll on
// their own.

interface NavItem {
  readonly to: "/" | "/agents" | "/activity" | "/approvals" | "/connections" | "/settings";
  readonly label: string;
  readonly icon: LucideIcon;
  readonly exact?: boolean;
  /** Shown in the tooltip. */
  readonly keys?: string;
  /** Not built yet: dimmed and tagged, so nobody clicks into a dead end. */
  readonly soon?: boolean;
}

const NAV: readonly NavItem[] = [
  { to: "/", label: "Home", icon: House, exact: true, keys: "G H" },
  { to: "/agents", label: "Agents", icon: Ghost, keys: "G A" },
  { to: "/activity", label: "Activity", icon: Activity, keys: "G R" },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/connections", label: "Connections", icon: Plug, soon: true },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal, keys: "G S" },
];

/** What needs someone: agents stuck now, and requests waiting for an answer. */
function useAttention(agents: readonly Agent[] | undefined) {
  const moods = useAgentMoods(agents);
  const stuck = (agents ?? []).filter((a) => moods.get(a.id)?.mood === "error").length;
  const { data: approvals } = useApprovals();
  return { moods, stuck, waiting: approvals?.length ?? 0 };
}

export function AppShell({ session, children }: { session: SessionResponse; children: ReactNode }) {
  const matches = useMatches();
  const navigate = useNavigate();
  const fullBleed = matches.some((m) => m.staticData.fullBleed);
  const title = [...matches].reverse().find((m) => m.staticData.title)?.staticData.title;
  const [collapsed, setCollapsed] = useStoredFlag("ofa-sidebar-folded", false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const openPalette = (query = "") => {
    setPaletteQuery(query);
    setPaletteOpen(true);
  };
  const { data: agents } = useAgents();
  const { moods, stuck, waiting } = useAttention(agents);
  useApprovalAlerts(agents);

  useGlobalShortcuts({
    openPalette: () => openPalette(),
    toggleSidebar: () => setCollapsed(!collapsed),
    go: (to) => void navigate({ to }),
  });

  // "Keyboard shortcuts" in the user menu, and "?" anywhere, open the list.
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
      <Sidebar
        session={session}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        onSearch={() => openPalette()}
        agents={agents ?? []}
        moods={moods}
        stuck={stuck}
        waiting={waiting}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <HealthBanner />
        {!fullBleed && <MobileTopBar session={session} onSearch={() => openPalette()} />}
        <main
          id="main"
          data-scroll-restoration-id="main"
          className={cn("min-h-0 flex-1", fullBleed ? "overflow-hidden" : "overflow-y-auto")}
        >
          {fullBleed ? (
            children
          ) : (
            <div className="mx-auto w-full max-w-[1200px] px-4 pt-2 pb-32 md:px-8 md:pt-8 md:pb-12">
              {children}
            </div>
          )}
        </main>
      </div>

      {!fullBleed && <BottomNav stuck={stuck} onAsk={() => openPalette()} />}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        agents={agents ?? []}
        onToggleSidebar={() => setCollapsed(!collapsed)}
        initialQuery={paletteQuery}
      />
      <Toaster raised={!fullBleed} />
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

/** A hover and focus label beside an item of the folded rail. */
function RailTip({ label, keys }: { label: string; keys?: string }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none invisible absolute top-1/2 left-full z-50 ml-3 flex -translate-y-1/2 items-center gap-2 rounded-[10px] bg-[#f4f4f0] px-2.5 py-1.5 text-[13px] font-semibold whitespace-nowrap text-[#0e0e0f] opacity-0 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
    >
      {label}
      {keys && <span className="font-mono text-[11px] font-normal text-[#5c5c61]">{keys}</span>}
    </span>
  );
}

const navItemClass = (collapsed: boolean) =>
  cn(
    "group relative flex h-10 items-center rounded-full text-[14.5px] font-medium text-[#c8c8cc] transition-colors duration-150",
    "outline-none hover:bg-white/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary",
    "data-[status=active]:bg-primary data-[status=active]:font-semibold data-[status=active]:text-primary-foreground",
    collapsed ? "w-11 justify-center self-center" : "gap-3 px-3",
  );

function Sidebar(props: {
  session: SessionResponse;
  collapsed: boolean;
  onToggle: () => void;
  onSearch: () => void;
  agents: readonly Agent[];
  moods: ReturnType<typeof useAgentMoods>;
  stuck: number;
  waiting: number;
}) {
  const { collapsed } = props;
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        "hidden h-dvh shrink-0 flex-col gap-4 border-r border-sidebar-border bg-sidebar pt-4 pb-3 text-sidebar-foreground transition-[width] duration-200 ease-[cubic-bezier(.2,.8,.2,1)] md:flex",
        collapsed ? "w-[72px] px-0" : "w-[248px] px-3",
      )}
    >
      <div
        className={cn("flex items-center", collapsed ? "justify-center" : "justify-between pl-2")}
      >
        {collapsed ? (
          <Link
            to="/"
            aria-label="Home"
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <BrandMark />
          </Link>
        ) : (
          <Wordmark />
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={props.onToggle}
            aria-label={toggleLabel}
            title={`${toggleLabel}  [`}
            className="flex size-9 items-center justify-center rounded-full text-sidebar-muted outline-none hover:bg-white/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ToggleIcon className="size-[18px]" aria-hidden />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={props.onSearch}
        aria-label={`Search or jump to, ${MOD_K}`}
        className={cn(
          "group relative flex h-10 items-center rounded-[12px] border border-sidebar-border bg-white/[0.03] text-sm text-sidebar-muted outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary",
          collapsed ? "w-11 justify-center self-center" : "gap-2.5 px-3",
        )}
      >
        <Search className="size-4 shrink-0" aria-hidden />
        {collapsed ? (
          <RailTip label="Search" keys={MOD_K} />
        ) : (
          <>
            <span className="truncate">Search</span>
            <kbd className="ml-auto rounded-[6px] border border-sidebar-border px-1.5 font-mono text-[11px] whitespace-nowrap">
              {MOD_K}
            </kbd>
          </>
        )}
      </button>

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map((item) => {
          const Icon = item.icon;
          const badge =
            item.to === "/agents" && props.stuck > 0
              ? { n: props.stuck, label: "stuck", tone: "bg-destructive text-background" }
              : item.to === "/approvals" && props.waiting > 0
                ? { n: props.waiting, label: "waiting", tone: "bg-primary text-primary-foreground" }
                : null;
          return (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              aria-label={
                collapsed ? `${item.label}${item.soon ? ", coming soon" : ""}` : undefined
              }
              className={cn(navItemClass(collapsed), item.soon && "text-[#6a6a70]")}
            >
              <Icon className="size-[18px] shrink-0" aria-hidden />
              {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
              {!collapsed && item.soon && (
                <span className="eyebrow rounded-full border border-sidebar-border px-1.5 py-px text-[9.5px] text-[#6a6a70]">
                  Soon
                </span>
              )}
              {badge !== null && (
                <span
                  aria-label={`${badge.n} ${badge.label}`}
                  className={cn(
                    "flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10.5px] font-semibold",
                    badge.tone,
                    collapsed && "absolute -top-0.5 -right-0.5",
                  )}
                >
                  {badge.n}
                </span>
              )}
              {collapsed && (
                <RailTip label={item.soon ? `${item.label} · soon` : item.label} keys={item.keys} />
              )}
            </Link>
          );
        })}
      </nav>

      <AgentList collapsed={collapsed} agents={props.agents} moods={props.moods} />

      {collapsed && (
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={toggleLabel}
          className="group relative flex size-10 items-center justify-center self-center rounded-full text-sidebar-muted outline-none hover:bg-white/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ToggleIcon className="size-[18px]" aria-hidden />
          <RailTip label="Expand sidebar" keys="[" />
        </button>
      )}
      <UserMenu session={props.session} collapsed={collapsed} />
    </aside>
  );
}

function AgentList(props: {
  collapsed: boolean;
  agents: readonly Agent[];
  moods: ReturnType<typeof useAgentMoods>;
}) {
  const { collapsed } = props;
  const shown = props.agents.slice(0, 8);
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto border-t border-sidebar-border pt-3",
        collapsed && "mx-4 items-center",
      )}
    >
      {!collapsed && (
        <div className="flex items-center justify-between pr-1 pb-1.5 pl-3">
          <span className="eyebrow text-[10.5px] text-[#6a6a70]">Agents</span>
          <Link
            to="/agents/new"
            aria-label="Hatch an agent"
            title="Hatch an agent"
            className="flex size-7 items-center justify-center rounded-full text-sidebar-muted outline-none hover:bg-white/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Plus className="size-4" aria-hidden />
          </Link>
        </div>
      )}
      {shown.map((agent) => {
        const mood: FamiliarMood = props.moods.get(agent.id)?.mood ?? "idle";
        const word = MOOD_WORDS[mood];
        return (
          <Link
            key={agent.id}
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            aria-label={`${agent.name}${word ? `, ${word.toLowerCase()}` : ""}`}
            className={cn(
              "group relative flex shrink-0 items-center rounded-[12px] text-sm outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-primary data-[status=active]:bg-white/[0.07]",
              collapsed ? "size-11 justify-center" : "h-10 gap-2.5 px-2",
            )}
          >
            <Familiar
              look={agent.spec.avatar}
              mood={mood}
              size={collapsed ? 34 : 30}
              ring="var(--sidebar)"
              animate={shouldAnimate(mood)}
              className={cn(mood === "asleep" && "opacity-70")}
            />
            {!collapsed && (
              <>
                <span className={cn("flex-1 truncate", mood === "asleep" && "text-sidebar-muted")}>
                  {agent.name}
                </span>
                {word && (
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      mood === "error"
                        ? "text-destructive"
                        : mood === "waiting"
                          ? "text-warning"
                          : mood === "asleep"
                            ? "text-[#6a6a70]"
                            : "text-primary",
                    )}
                  >
                    {word}
                  </span>
                )}
              </>
            )}
            {collapsed && <RailTip label={`${agent.name}${word ? ` · ${word}` : ""}`} />}
          </Link>
        );
      })}
      {props.agents.length > shown.length && !collapsed && (
        <Link
          to="/agents"
          className="px-3 py-2 text-[13px] text-sidebar-muted outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          All {props.agents.length} agents
        </Link>
      )}
      {collapsed && (
        <Link
          to="/agents/new"
          aria-label="Hatch an agent"
          className="group relative mt-1 flex size-11 shrink-0 items-center justify-center rounded-full border border-dashed border-sidebar-border text-sidebar-muted outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Plus className="size-4" aria-hidden />
          <RailTip label="Hatch an agent" />
        </Link>
      )}
      {props.agents.length === 0 && !collapsed && (
        <Link
          to="/agents/new"
          className="mx-1 rounded-[12px] border border-dashed border-sidebar-border px-3 py-3 text-[13px] text-sidebar-muted outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          No agents yet. Hatch your first one.
        </Link>
      )}
    </div>
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

const THEMES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "Auto", icon: Monitor },
];

/** Close a popover on Escape or a click outside it. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);
  return ref;
}

function UserMenu({ session, collapsed }: { session: SessionResponse; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const { preference } = useTheme();
  const { signOut, pending } = useSignOut();
  const item =
    "flex h-10 w-full items-center gap-3 rounded-[12px] px-3 text-sm text-popover-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div ref={ref} className="relative border-t border-sidebar-border pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${session.user.name}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-[12px] text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-primary",
          collapsed ? "justify-center py-1" : "p-1.5",
        )}
      >
        <UserInitial name={session.user.name} className="size-9 rounded-[12px] text-[15px]" />
        {!collapsed && (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13.5px] font-semibold">{session.user.name}</span>
              <span className="truncate text-xs text-sidebar-muted">
                {session.workspace
                  ? `${roleLabel(session.workspace.role)} · ${session.workspace.name}`
                  : session.user.email}
              </span>
            </span>
            <ChevronsUpDown className="size-4 text-sidebar-muted" aria-hidden />
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute bottom-full z-50 mb-2 flex w-64 flex-col gap-0.5 rounded-[18px] border bg-popover p-2 text-popover-foreground shadow-2xl",
            collapsed ? "left-2" : "left-0",
          )}
        >
          <div className="flex flex-col px-3 pt-1.5 pb-2">
            <span className="truncate text-sm font-semibold">{session.user.name}</span>
            <span className="truncate text-xs text-muted-foreground">{session.user.email}</span>
          </div>
          <div
            role="group"
            aria-label="Theme"
            className="mx-1 mb-1 flex gap-1 rounded-full border p-1"
          >
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={preference === value}
                onClick={() => setThemePreference(value)}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  preference === value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <Link to="/settings" role="menuitem" className={item} onClick={() => setOpen(false)}>
            <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden /> Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent("ofa:shortcuts"));
            }}
          >
            <Keyboard className="size-4 text-muted-foreground" aria-hidden /> Keyboard shortcuts
          </button>
          <div className="my-1 border-t" />
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={pending}
            onClick={signOut}
          >
            <LogOut className="size-4 text-muted-foreground" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ── Phone ────────────────────────────────────────────────────────────────────

function MobileTopBar({ session, onSearch }: { session: SessionResponse; onSearch: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const { dark } = useTheme();
  const { signOut, pending } = useSignOut();
  const item =
    "flex h-12 w-full items-center gap-3 rounded-[14px] px-3.5 text-[15px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2 md:hidden">
      <div ref={ref} className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="workspace-menu"
          onClick={() => setOpen(!open)}
          className="flex h-11 items-center gap-2 rounded-full border border-input pr-3.5 pl-1 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UserInitial name={session.user.name} className="size-[34px] rounded-full text-[15px]" />
          <span className="max-w-[180px] truncate">{session.workspace?.name ?? "One-for-All"}</span>
          <ChevronsUpDown className="size-3.5" aria-hidden />
        </button>
        {open && (
          <div
            id="workspace-menu"
            className="absolute top-13 left-0 z-40 flex w-64 flex-col gap-1 rounded-lg border bg-popover p-2 text-popover-foreground shadow-2xl"
          >
            <div className="flex flex-col px-3.5 pt-2 pb-2.5">
              <span className="truncate text-sm font-semibold">{session.user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{session.user.email}</span>
            </div>
            <Link to="/connections" className={item} onClick={() => setOpen(false)}>
              <Plug className="size-[18px]" aria-hidden /> Connections
            </Link>
            <Link to="/settings" className={item} onClick={() => setOpen(false)}>
              <SlidersHorizontal className="size-[18px]" aria-hidden /> Settings
            </Link>
            <button
              type="button"
              className={item}
              onClick={() => setThemePreference(dark ? "light" : "dark")}
            >
              {dark ? (
                <Sun className="size-[18px]" aria-hidden />
              ) : (
                <Moon className="size-[18px]" aria-hidden />
              )}
              {dark ? "Light mode" : "Dark mode"}
            </button>
            <button type="button" className={item} disabled={pending} onClick={signOut}>
              <LogOut className="size-[18px]" aria-hidden /> Sign out
            </button>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search"
        className="flex size-11 items-center justify-center rounded-full border border-input outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="size-[18px]" aria-hidden />
      </button>
    </div>
  );
}

const TABS = [
  { to: "/", label: "Home", icon: House, exact: true },
  { to: "/agents", label: "Agents", icon: Ghost, exact: false },
  { to: "/activity", label: "Activity", icon: Activity, exact: false },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal, exact: false },
] as const;

function BottomNav({ stuck, onAsk }: { stuck: number; onAsk: () => void }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-3 bottom-4 z-30 flex items-center gap-2.5 md:hidden"
    >
      <div className="flex h-16 flex-1 items-stretch justify-between rounded-full border border-[#2a2a2e] bg-[#1c1c1f]/95 px-2 backdrop-blur">
        {TABS.map(({ to, label, icon: Icon, exact }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact }}
            className="relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[10.5px] font-semibold text-[#8a8a90] outline-none focus-visible:ring-2 focus-visible:ring-primary data-[status=active]:text-[#f4f4f0]"
          >
            <Icon className="size-[21px]" aria-hidden />
            {label}
            {to === "/agents" && stuck > 0 && (
              <span
                aria-label={`${stuck} stuck`}
                className="absolute top-2 right-[calc(50%-18px)] size-2 rounded-full bg-destructive ring-2 ring-[#1c1c1f]"
              />
            )}
          </Link>
        ))}
      </div>
      <button
        type="button"
        onClick={onAsk}
        aria-label="Ask an agent"
        className="flex size-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-full bg-primary text-[10.5px] font-bold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <MessageCircle className="size-[22px]" strokeWidth={2.4} aria-hidden />
        Ask
      </button>
    </nav>
  );
}
