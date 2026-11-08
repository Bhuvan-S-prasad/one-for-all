import { queryKeys, useApiClient, useRunSearch } from "@ofa/client";
import type { Agent } from "@ofa/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowUp,
  BookOpen,
  Brain,
  Ghost,
  History,
  House,
  LayoutGrid,
  Lightbulb,
  Moon,
  PanelLeft,
  Plus,
  Repeat,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  SquarePen,
  Sun,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Familiar } from "@/components/familiar";
import { timeAgo } from "@/lib/format";
import { SHORTCUTS } from "@/lib/shortcuts";
import { toast } from "@/lib/toast";
import { setThemePreference, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// ⌘K / Ctrl K from anywhere (UX.04): jump to an agent, a page or a past run,
// run an action, or start a message to an agent. "?" lists the shortcuts.

interface Entry {
  readonly id: string;
  readonly group: string;
  readonly label: ReactNode;
  readonly hint?: string;
  readonly icon: ReactNode;
  readonly run: () => void;
}

const icon = (Icon: LucideIcon) => (
  <Icon className="size-[18px] text-muted-foreground" aria-hidden />
);

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  agents: readonly Agent[];
  onToggleSidebar: () => void;
  /** "?" opens it on the shortcut list. */
  initialQuery?: string;
}) {
  if (!props.open) return null;
  return <Palette {...props} />;
}

function Palette({
  onClose,
  agents,
  onToggleSidebar,
  initialQuery = "",
}: {
  onClose: () => void;
  agents: readonly Agent[];
  onToggleSidebar: () => void;
  initialQuery?: string;
}) {
  const navigate = useNavigate();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const { dark } = useTheme();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const q = query.trim();
  const searching = q.length >= 2 && q !== "?";
  const runSearch = useRunSearch({ q: searching ? q : undefined }, { enabled: searching });
  const runs = searching ? (runSearch.data?.pages[0]?.items ?? []).slice(0, 5) : [];

  useEffect(() => inputRef.current?.focus(), []);

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const entries: Entry[] = (() => {
    if (q === "?") {
      return SHORTCUTS.map((s) => ({
        id: `key-${s.keys}`,
        group: "Keyboard shortcuts",
        label: s.label,
        hint: s.keys,
        icon: icon(Search),
        run: () => undefined,
      }));
    }
    const list: Entry[] = [];
    const active = agents.filter((a) => a.status === "active");
    if (q) {
      // "@scout find x" asks that agent; plain text offers the first few.
      const mention = /^@(\S+)\s*(.*)$/.exec(q);
      const askable = mention
        ? active.filter((a) => a.name.toLowerCase().startsWith((mention[1] ?? "").toLowerCase()))
        : active;
      const text = mention ? (mention[2] ?? "") : q;
      if (text) {
        for (const agent of askable.slice(0, 3)) {
          list.push({
            id: `ask-${agent.id}`,
            group: "Ask",
            label: (
              <>
                Ask {agent.name} <span className="text-muted-foreground">“{text}”</span>
              </>
            ),
            icon: (
              <span className="flex size-[22px] items-center justify-center rounded-[7px] bg-primary text-primary-foreground">
                <ArrowUp className="size-3.5" strokeWidth={2.6} aria-hidden />
              </span>
            ),
            run: go(
              () =>
                void navigate({
                  to: "/agents/$agentId",
                  params: { agentId: agent.id },
                  search: { draft: text },
                }),
            ),
          });
        }
      }
    }
    for (const agent of agents.filter((a) => !q || matches(`${a.name} ${a.spec.job}`, q))) {
      list.push({
        id: `agent-${agent.id}`,
        group: "Agents",
        label: agent.name,
        hint: agent.spec.job,
        icon: <Familiar look={agent.spec.avatar} size={24} ring="var(--popover)" />,
        run: go(() => void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } })),
      });
    }
    // A named agent also offers a new chat, its history and its memory (UX.13, UX.14).
    const named = q ? agents.filter((a) => matches(a.name, q.replace(/^@/, ""))).slice(0, 2) : [];
    for (const agent of named) {
      const params = { agentId: agent.id };
      list.push(
        {
          id: `new-${agent.id}`,
          group: agent.name,
          label: `New chat with ${agent.name}`,
          hint: "N in a chat",
          icon: icon(SquarePen),
          // The palette closes first, so this uses the client directly.
          run: go(
            () =>
              void api
                .newThread(agent.id)
                .then((thread) => {
                  queryClient.setQueryData(queryKeys.agentThread(agent.id), thread);
                  void queryClient.invalidateQueries({ queryKey: queryKeys.threadLists });
                  return navigate({ to: "/agents/$agentId", params, search: {} });
                })
                .catch((e: Error) => toast({ message: e.message, tone: "error" })),
          ),
        },
        {
          id: `history-${agent.id}`,
          group: agent.name,
          label: `${agent.name}'s chat history`,
          icon: icon(History),
          run: go(() => void navigate({ to: "/agents/$agentId/history", params })),
        },
        {
          id: `memory-${agent.id}`,
          group: agent.name,
          label: `What ${agent.name} remembers`,
          icon: icon(Lightbulb),
          run: go(() => void navigate({ to: "/agents/$agentId/memory", params })),
        },
      );
    }
    for (const run of runs) {
      const agent = agents.find((a) => a.id === run.agentId);
      list.push({
        id: `run-${run.id}`,
        group: "Runs",
        label: run.request ?? "Run",
        hint: `${agent?.name ?? "Agent"} · ${timeAgo(run.createdAt)}`,
        icon: icon(Activity),
        run: go(() => void navigate({ to: "/activity", search: { run: run.id } })),
      });
    }
    const pages: [string, LucideIcon, () => void][] = [
      ["Chats", House, () => void navigate({ to: "/" })],
      ["Overview", LayoutGrid, () => void navigate({ to: "/overview" })],
      ["Approvals", ShieldCheck, () => void navigate({ to: "/approvals" })],
      ["Agents", Ghost, () => void navigate({ to: "/agents" })],
      ["Activity", Activity, () => void navigate({ to: "/activity" })],
      ["Routines", Repeat, () => void navigate({ to: "/routines" })],
      ["Skills", BookOpen, () => void navigate({ to: "/skills" })],
      ["Memory", Brain, () => void navigate({ to: "/memory" })],
      ["Settings", SlidersHorizontal, () => void navigate({ to: "/settings" })],
    ];
    for (const [label, Icon, fn] of pages.filter(([label]) => !q || matches(label, q))) {
      list.push({ id: `page-${label}`, group: "Go to", label, icon: icon(Icon), run: go(fn) });
    }
    const actions: [string, LucideIcon, () => void][] = [
      ["Hatch an agent", Plus, () => void navigate({ to: "/agents/new" })],
      [
        dark ? "Switch to light theme" : "Switch to dark theme",
        dark ? Sun : Moon,
        () => setThemePreference(dark ? "light" : "dark"),
      ],
      ["New group chat", Users, () => void navigate({ to: "/groups/new" })],
      ["Hide or show the sidebar", PanelLeft, onToggleSidebar],
    ];
    for (const [label, Icon, fn] of actions.filter(([label]) => !q || matches(label, q))) {
      list.push({ id: `do-${label}`, group: "Actions", label, icon: icon(Icon), run: go(fn) });
    }
    return list;
  })();

  const safeActive = Math.min(active, Math.max(entries.length - 1, 0));
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((safeActive + 1) % Math.max(entries.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((safeActive - 1 + entries.length) % Math.max(entries.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      entries[safeActive]?.run();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/55 px-4 pt-[12vh] backdrop-blur-[2px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="flex max-h-[70vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[22px] border bg-popover text-popover-foreground shadow-2xl"
        onKeyDown={onKey}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <Search className="size-[18px] text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={entries[safeActive] ? `${listId}-${safeActive}` : undefined}
            aria-label="Search agents, runs and commands"
            placeholder="Search agents, runs and commands, or type ? for shortcuts"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="h-full flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded-[6px] border px-1.5 font-mono text-[11px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="overflow-y-auto p-2">
          {entries.length === 0 && (
            <li className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nothing matches “{q}”.
            </li>
          )}
          {entries.map((entry, i) => {
            const heading = entries[i - 1]?.group !== entry.group ? entry.group : null;
            return (
              <li key={entry.id} role="presentation">
                {heading && (
                  <div
                    className="eyebrow px-3 pt-2.5 pb-1 text-[10.5px] text-muted-foreground"
                    aria-hidden
                  >
                    {heading}
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === safeActive}
                  onPointerMove={() => setActive(i)}
                  onClick={entry.run}
                  className={cn(
                    "flex h-11 cursor-pointer items-center gap-3 rounded-[12px] px-3 text-[14px]",
                    i === safeActive && "bg-accent",
                  )}
                >
                  <span className="flex w-6 shrink-0 justify-center">{entry.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.hint && (
                    <span className="max-w-[45%] truncate font-mono text-[11.5px] text-muted-foreground">
                      {entry.hint}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex shrink-0 gap-4 border-t px-5 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>@name ask an agent</span>
          <span className="ml-auto">? shortcuts</span>
        </div>
      </div>
    </div>
  );
}
