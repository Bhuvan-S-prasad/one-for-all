import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Spark } from "@/components/wordmark";
import { SECTIONS } from "@/lib/pages";
import { REPO_URL } from "@/lib/links";

// The frame of every page: a top bar with search, the contents on the left,
// the page in the middle, and "On this page" on the right when it has one.

export interface TocEntry {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

const REFERENCE = [
  { to: "/code", label: "Code explorer" },
  { to: "/data", label: "Data model" },
  { to: "/api", label: "API endpoints" },
  { to: "/jobs", label: "Jobs and events" },
  { to: "/tools", label: "Agent tools" },
  { to: "/decisions", label: "Decisions" },
];

function NavLink(props: {
  to: string;
  active: boolean;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={props.to}
      onClick={props.onNavigate}
      aria-current={props.active ? "page" : undefined}
      className={`block rounded-[10px] px-3 py-1.5 text-[14.5px] transition-colors ${
        props.active
          ? "bg-primary font-semibold text-primary-foreground"
          : "text-muted-foreground hover:bg-card hover:text-foreground"
      }`}
    >
      {props.children}
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Contents" className="flex flex-col gap-7">
      <div className="flex flex-col gap-0.5">
        <NavLink to="/" active={path === "/"} onNavigate={onNavigate}>
          Start here
        </NavLink>
      </div>
      {SECTIONS.map((section) => (
        <div key={section.key} className="flex flex-col gap-0.5">
          <Link
            to={`/${section.key}`}
            onClick={onNavigate}
            className="mb-1 px-3 font-display text-[15px] font-bold text-foreground hover:text-primary"
          >
            {section.title}
          </Link>
          {section.pages.map((page, i) => {
            const to = `/${section.key}/${page.slug}`;
            return (
              <NavLink key={page.slug} to={to} active={path === to} onNavigate={onNavigate}>
                {section.key === "path" ? `${i + 1}. ` : ""}
                {page.title}
              </NavLink>
            );
          })}
          {section.pages.length === 0 && (
            <span className="px-3 text-[13.5px] text-muted-foreground">Coming soon</span>
          )}
        </div>
      ))}
      <div className="flex flex-col gap-0.5">
        <span className="mb-1 px-3 font-display text-[15px] font-bold">Reference</span>
        {REFERENCE.map((r) => (
          <NavLink
            key={r.to}
            to={r.to}
            active={path === r.to || path.startsWith(`${r.to}/`)}
            onNavigate={onNavigate}
          >
            {r.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

function Search({ id }: { id: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) void navigate({ to: "/search", search: { q: q.trim() } });
  };
  return (
    <form onSubmit={submit} role="search" className="min-w-0 flex-1 md:max-w-[420px]">
      <label htmlFor={id} className="sr-only">
        Search functions, files, tables, endpoints and pages
      </label>
      <input
        id={id}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search runAgent, thread, /api/runs…"
        className="h-10 w-full rounded-full border border-input bg-card px-4 text-[14.5px] outline-none placeholder:text-muted-foreground focus:border-ring"
      />
    </form>
  );
}

function OnThisPage({ toc }: { toc: readonly TocEntry[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const els = toc
      .map((t) => document.getElementById(t.id))
      .filter((e): e is HTMLElement => e !== null);
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).map((e) => e.target.id);
        if (seen[0]) setCurrent(seen[0]);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [toc]);
  if (toc.length < 2) return null;
  return (
    <nav aria-label="On this page" className="flex flex-col gap-1 text-[13.5px]">
      <span className="mb-2 font-display text-[14.5px] font-bold">On this page</span>
      {toc.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          className={`py-0.5 transition-colors ${t.level === 3 ? "pl-3" : ""} ${
            current === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.text}
        </a>
      ))}
    </nav>
  );
}

export function Layout(props: { children: ReactNode; toc?: readonly TocEntry[]; wide?: boolean }) {
  const [menu, setMenu] = useState(false);
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border bg-background/90 px-4 backdrop-blur md:px-6">
        <button
          type="button"
          onClick={() => setMenu(!menu)}
          aria-expanded={menu}
          aria-controls="mobile-nav"
          className="flex h-10 items-center rounded-full border border-input px-3.5 text-[14px] lg:hidden"
        >
          Menu
        </button>
        <Link to="/" className="flex shrink-0 items-center gap-2">
          <Spark />
          <span className="font-display text-[19px] font-extrabold tracking-[-0.03em]">
            One-for-All <span className="text-primary">Learn</span>
          </span>
        </Link>
        {/* On phones the search box lives in the menu, where it has room. */}
        <div className="hidden min-w-0 flex-1 sm:flex">
          <Search id="search" />
        </div>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto hidden text-[14px] text-muted-foreground hover:text-foreground md:block"
        >
          Repository ↗
        </a>
      </header>
      {menu && (
        <div
          id="mobile-nav"
          className="flex flex-col gap-6 border-b border-border px-4 py-6 lg:hidden"
        >
          <div className="flex sm:hidden">
            <Search id="search-menu" />
          </div>
          <Sidebar onNavigate={() => setMenu(false)} />
        </div>
      )}
      <div className="mx-auto flex max-w-[1500px] gap-10 px-4 md:px-6">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[250px] shrink-0 overflow-y-auto py-8 lg:block">
          <Sidebar />
        </aside>
        <main className={`min-w-0 flex-1 py-10 ${props.wide ? "" : "max-w-[860px]"}`}>
          {props.children}
        </main>
        {props.toc && props.toc.length > 1 && (
          <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-[220px] shrink-0 overflow-y-auto py-10 xl:block">
            <OnThisPage toc={props.toc} />
          </aside>
        )}
      </div>
    </div>
  );
}

/** A page's title block. */
export function PageTitle(props: { eyebrow?: string; title: ReactNode; lede?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-3">
      {props.eyebrow && (
        <span className="eyebrow text-[11.5px] text-muted-foreground">{props.eyebrow}</span>
      )}
      <h1 className="text-[clamp(30px,3.6vw,44px)] leading-[1.05] font-extrabold">{props.title}</h1>
      {props.lede && <p className="max-w-[68ch] text-[17px] text-muted-foreground">{props.lede}</p>}
    </header>
  );
}
