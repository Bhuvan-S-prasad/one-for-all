import { useHealth } from "@ofa/client";
import type { SessionResponse } from "@ofa/contracts";
import { Link, useMatches } from "@tanstack/react-router";
import {
  Activity,
  ChevronDown,
  Ghost,
  House,
  LogOut,
  Moon,
  Plug,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/brand-mark";
import { roleLabel } from "@/lib/format";
import { setThemePreference, useTheme } from "@/lib/theme";
import { useSignOut } from "@/lib/use-sign-out";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Home", exact: true },
  { to: "/agents", label: "Agents", exact: false },
  { to: "/activity", label: "Activity", exact: false },
  { to: "/approvals", label: "Approvals", exact: false },
  { to: "/connections", label: "Connections", exact: false },
  { to: "/settings", label: "Settings", exact: false },
] as const;

const BOTTOM_NAV = [
  { to: "/", label: "Home", icon: House, exact: true },
  { to: "/agents", label: "Agents", icon: Ghost, exact: false },
  { to: "/activity", label: "Activity", icon: Activity, exact: false },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck, exact: false },
] as const;

/** The signed-in layout: sidebar on wide screens, top menu and bottom bar on phones. */
export function AppShell({ session, children }: { session: SessionResponse; children: ReactNode }) {
  const matches = useMatches();
  const title =
    [...matches].reverse().find((match) => match.staticData.title)?.staticData.title ??
    "One-for-All";
  const workspaceName = session.workspace?.name ?? "No workspace";

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[236px_minmax(0,1fr)]">
      <Sidebar session={session} />

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 hidden h-16 items-center justify-between gap-4 border-b bg-background/90 px-8 backdrop-blur md:flex">
          <span className="eyebrow truncate text-muted-foreground">
            {workspaceName} / <span className="text-foreground">{title}</span>
          </span>
          <HealthPill />
        </header>

        <MobileTopBar session={session} />

        <main className="w-full max-w-[1200px] px-4 pt-2 pb-32 md:px-8 md:py-6">{children}</main>
      </div>

      <BottomNav />
    </div>
  );
}

function HealthPill() {
  const health = useHealth();
  const state = health.isPending
    ? { text: "Checking…", dot: "bg-muted-foreground" }
    : health.isError
      ? { text: "Server unreachable", dot: "bg-destructive" }
      : health.data.status === "ok"
        ? { text: "All systems normal", dot: "bg-success" }
        : { text: "Degraded", dot: "bg-warning" };
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span className="flex h-8 items-center gap-2 rounded-full border px-3 font-mono text-xs">
        <span aria-hidden className={cn("size-[7px] rounded-full", state.dot)} />
        {state.text}
      </span>
      {health.data && (
        <span className="font-mono text-xs text-muted-foreground">v{health.data.version}</span>
      )}
    </div>
  );
}

function ThemeToggle({ className }: { className?: string }) {
  const { dark } = useTheme();
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setThemePreference(dark ? "light" : "dark")}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full border border-sidebar-border text-[#c8c8cc] transition-colors outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
    </button>
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

function Sidebar({ session }: { session: SessionResponse }) {
  return (
    <aside
      aria-label="Sidebar"
      className="sticky top-0 hidden h-dvh flex-col gap-5.5 border-r border-sidebar-border bg-sidebar px-3.5 pt-5.5 pb-4 text-sidebar-foreground md:flex"
    >
      <Wordmark className="px-2" />

      {session.workspace && (
        <div className="flex flex-col gap-1 rounded-[16px] border border-sidebar-border px-3.5 py-3">
          <span className="eyebrow text-[11px] text-sidebar-muted">Workspace</span>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{session.workspace.name}</span>
            <span className="eyebrow rounded-full bg-primary px-[7px] py-[3px] text-[10px] text-primary-foreground">
              {roleLabel(session.workspace.role)}
            </span>
          </div>
        </div>
      )}

      <nav aria-label="Main" className="flex flex-col gap-1">
        {NAV.map(({ to, label, exact }, index) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact }}
            className={cn(
              "flex h-11 items-center gap-3 rounded-full px-3.5 text-[15px] font-medium text-[#c8c8cc] transition-colors",
              "outline-none hover:bg-white/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-primary",
              "data-[status=active]:bg-primary data-[status=active]:font-semibold data-[status=active]:text-primary-foreground",
            )}
          >
            <span className="font-mono text-[11px] opacity-60">
              {String(index + 1).padStart(2, "0")}
            </span>
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 border-t border-sidebar-border pt-3.5">
        <UserInitial name={session.user.name} className="size-9 rounded-[12px] text-[15px]" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{session.user.name}</span>
          <span className="truncate text-xs text-sidebar-muted">{session.user.email}</span>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}

function MobileTopBar({ session }: { session: SessionResponse }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { dark } = useTheme();
  const { signOut, pending } = useSignOut();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const item =
    "flex h-12 w-full items-center gap-3 rounded-[14px] px-3.5 text-[15px] font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-5 pb-2 md:hidden">
      <div ref={menuRef} className="relative">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="workspace-menu"
          onClick={() => setOpen((value) => !value)}
          className="flex h-11 items-center gap-2 rounded-full border border-input pr-3.5 pl-1 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UserInitial name={session.user.name} className="size-[34px] rounded-full text-[15px]" />
          <span className="max-w-[180px] truncate">{session.workspace?.name ?? "One-for-All"}</span>
          <ChevronDown className="size-3.5" aria-hidden />
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
    </div>
  );
}

function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-4 bottom-5 z-30 flex items-center gap-2.5 md:hidden"
    >
      <div className="flex h-16 flex-1 items-center justify-between rounded-full border border-[#2a2a2e] bg-[#1c1c1f]/92 p-1.5 backdrop-blur">
        {BOTTOM_NAV.map(({ to, label, icon: Icon, exact }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact }}
            aria-label={label}
            className="flex size-13 items-center justify-center rounded-full text-[#c8c8cc] outline-none focus-visible:ring-2 focus-visible:ring-primary data-[status=active]:bg-[#f4f4f0] data-[status=active]:text-[#0e0e0f]"
          >
            <Icon className="size-[22px]" aria-hidden />
          </Link>
        ))}
      </div>
      <Link
        to="/agents"
        aria-label="Hatch a new agent"
        className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Plus className="size-[26px]" strokeWidth={2.4} aria-hidden />
      </Link>
    </nav>
  );
}
