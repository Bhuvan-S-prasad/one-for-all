import type { SessionResponse } from "@ofa/contracts";
import { Link, useMatches } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  House,
  LogOut,
  Menu,
  Moon,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { initials, roleLabel } from "@/lib/format";
import { setThemePreference, useTheme } from "@/lib/theme";
import { useSignOut } from "@/lib/use-sign-out";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Home", icon: House, exact: true },
  { to: "/agents", label: "Agents", icon: Bot, exact: false },
  { to: "/activity", label: "Activity", icon: Activity, exact: false },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck, exact: false },
  { to: "/connections", label: "Connections", icon: Plug, exact: false },
  { to: "/settings", label: "Settings", icon: SlidersHorizontal, exact: false },
] as const;

/** The signed-in layout: sidebar, page header and content. */
export function AppShell({ session, children }: { session: SessionResponse; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const matches = useMatches();
  const title =
    [...matches].reverse().find((match) => match.staticData.title)?.staticData.title ??
    "One-for-All";

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="flex min-h-dvh">
      {menuOpen && (
        <div
          className="fixed inset-0 z-30 bg-foreground/40 md:hidden"
          aria-hidden
          onClick={() => setMenuOpen(false)}
        />
      )}
      <Sidebar session={session} open={menuOpen} onClose={() => setMenuOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-15 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-9">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:hidden"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            onClick={() => setMenuOpen(true)}
          >
            <Menu className="size-5!" />
          </Button>
          <h1 className="text-xl font-semibold">{title}</h1>
          {session.workspace && (
            <span className="ml-auto hidden text-sm text-muted-foreground sm:block">
              {session.workspace.name}
            </span>
          )}
        </header>
        <main className="w-full max-w-[1000px] px-4 py-6 md:px-9 md:py-8">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({
  session,
  open,
  onClose,
}: {
  session: SessionResponse;
  open: boolean;
  onClose: () => void;
}) {
  const { dark } = useTheme();
  const { signOut, pending } = useSignOut();
  const themeLabel = dark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <aside
      id="app-sidebar"
      aria-label="Sidebar"
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col gap-5 border-r bg-card px-3.5 py-5 transition-transform",
        "md:sticky md:top-0 md:h-dvh md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full max-md:invisible",
      )}
    >
      <div className="flex items-center justify-between px-2">
        <Wordmark />
        <Button
          variant="ghost"
          size="icon"
          className="size-10 md:hidden"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      {session.workspace && (
        <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2.5">
          <span className="text-xs text-muted-foreground">Workspace</span>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{session.workspace.name}</span>
            <span className="rounded bg-accent px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-accent-foreground uppercase">
              {roleLabel(session.workspace.role)}
            </span>
          </div>
        </div>
      )}

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map(({ to, label, icon: Icon, exact }) => (
          <Link
            key={to}
            to={to}
            activeOptions={{ exact }}
            onClick={onClose}
            className={cn(
              "flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-muted-foreground transition-colors",
              "outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              "data-[status=active]:bg-accent data-[status=active]:font-semibold data-[status=active]:text-accent-foreground",
            )}
          >
            <Icon className="size-[18px]" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 border-t pt-3.5">
        <span
          aria-hidden
          className="flex size-8.5 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-semibold text-accent-foreground"
        >
          {initials(session.user.name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{session.user.name}</span>
          <span className="truncate text-xs text-muted-foreground">{session.user.email}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={themeLabel}
          title={themeLabel}
          onClick={() => setThemePreference(dark ? "light" : "dark")}
        >
          {dark ? <Sun /> : <Moon />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Sign out"
          title="Sign out"
          disabled={pending}
          onClick={signOut}
        >
          <LogOut />
        </Button>
      </div>
    </aside>
  );
}
