import { useAgents, useApprovals, useSkills } from "@ofa/client";
import type { SessionResponse } from "@ofa/contracts";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Brain,
  Ghost,
  Keyboard,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  Repeat,
  SlidersHorizontal,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useAgentMoods } from "@/lib/agents";
import { WORKSPACE_SECTIONS, type WorkspacePath } from "@/lib/conversations";
import { setThemePreference, useTheme, type ThemePreference } from "@/lib/theme";
import { useSignOut } from "@/lib/use-sign-out";
import { cn } from "@/lib/utils";
import { MENU_ITEM } from "@/components/ui/popover";

// Everything that isn't a conversation (ADR-0052): the workspace's pages, the
// theme and the account. Opened from the person's name in the sidebar, or the
// avatar on phones; on those pages the sidebar lists the same sections.

const ICONS: Record<WorkspacePath, LucideIcon> = {
  "/overview": LayoutGrid,
  "/agents": Ghost,
  "/activity": Activity,
  "/routines": Repeat,
  "/skills": BookOpen,
  "/memory": Brain,
  "/settings": SlidersHorizontal,
};

/** What waits in each section: requests, stuck agents, skills to review. */
export function useWorkspaceCounts(): Partial<Record<WorkspacePath, { n: number; label: string }>> {
  const { data: agents } = useAgents();
  const moods = useAgentMoods(agents);
  const { data: approvals } = useApprovals();
  const { data: skills } = useSkills();
  const stuck = (agents ?? []).filter((a) => moods.get(a.id)?.mood === "error").length;
  const waiting = approvals?.length ?? 0;
  const toReview = (skills ?? []).filter((s) => s.status === "proposed").length;
  return {
    ...(waiting ? { "/overview": { n: waiting, label: "waiting for you" } } : {}),
    ...(stuck ? { "/agents": { n: stuck, label: "stuck" } } : {}),
    ...(toReview ? { "/skills": { n: toReview, label: "to review" } } : {}),
  };
}

function Count({ n, label, tone }: { n: number; label: string; tone: "primary" | "destructive" }) {
  return (
    <span
      aria-label={`${n} ${label}`}
      className={cn(
        "ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10.5px] font-semibold",
        tone === "primary"
          ? "bg-primary text-primary-foreground"
          : "bg-destructive text-background",
      )}
    >
      {n}
    </span>
  );
}

const THEMES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "Auto", icon: Monitor },
];

/** The menu's contents, shared by the desktop popover and the phone sheet. */
export function WorkspaceMenuItems({
  session,
  onClose,
}: {
  session: SessionResponse;
  onClose: () => void;
}) {
  const counts = useWorkspaceCounts();
  const { preference } = useTheme();
  const { signOut, pending } = useSignOut();
  return (
    <>
      <div className="flex flex-col px-3 pt-1.5 pb-2">
        <span className="truncate text-sm font-semibold">{session.user.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {session.workspace?.name ?? session.user.email}
        </span>
      </div>
      {WORKSPACE_SECTIONS.map(({ to, label }) => {
        const Icon = ICONS[to];
        const count = counts[to];
        return (
          <Link key={to} to={to} role="menuitem" className={MENU_ITEM} onClick={onClose}>
            <Icon className="size-4 text-muted-foreground" aria-hidden />
            {label}
            {count && (
              <Count
                n={count.n}
                label={count.label}
                tone={to === "/agents" ? "destructive" : "primary"}
              />
            )}
          </Link>
        );
      })}
      <div className="my-1 border-t" />
      <div role="group" aria-label="Theme" className="mx-1 mb-1 flex gap-1 rounded-full border p-1">
        {THEMES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={preference === value}
            onClick={() => setThemePreference(value)}
            className={cn(
              "press flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
      <button
        type="button"
        role="menuitem"
        className={cn(MENU_ITEM, "hidden md:flex")}
        onClick={() => {
          onClose();
          window.dispatchEvent(new CustomEvent("ofa:shortcuts"));
        }}
      >
        <Keyboard className="size-4 text-muted-foreground" aria-hidden /> Keyboard shortcuts
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM}
        disabled={pending}
        onClick={signOut}
      >
        <LogOut className="size-4 text-muted-foreground" aria-hidden /> Sign out
      </button>
    </>
  );
}

/** The sidebar on the workspace's pages: back to the chats, then the sections. */
export function WorkspaceNav() {
  const counts = useWorkspaceCounts();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Workspace" className="flex flex-col gap-0.5">
      <Link
        to="/"
        className="press mb-2 flex h-10 items-center gap-2.5 rounded-[12px] px-3 text-[14px] font-semibold text-sidebar-foreground outline-none hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft className="size-4" aria-hidden /> Chats
      </Link>
      {WORKSPACE_SECTIONS.map(({ to, label }) => {
        const Icon = ICONS[to];
        const count = counts[to];
        const current =
          pathname === to ||
          (pathname.startsWith(`${to}/`) && !pathname.startsWith("/agents/")) ||
          (to === "/agents" && pathname === "/agents/new");
        return (
          <Link
            key={to}
            to={to}
            aria-current={current ? "page" : undefined}
            className={cn(
              "press flex h-10 items-center gap-3 rounded-[12px] px-3 text-[14.5px] outline-none focus-visible:ring-2 focus-visible:ring-primary",
              current
                ? "bg-white/[0.07] font-semibold text-sidebar-foreground"
                : "text-[#c8c8cc] hover:bg-white/[0.04] hover:text-sidebar-foreground",
            )}
          >
            <Icon className="size-[18px] shrink-0" aria-hidden />
            <span className="flex-1 truncate">{label}</span>
            {count && (
              <Count
                n={count.n}
                label={count.label}
                tone={to === "/agents" ? "destructive" : "primary"}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
