import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/wordmark";
import { REPO_URL } from "@/lib/site";
import { neighbours, SECTIONS } from "./pages";

// The docs' frame: a plain top bar, the contents on the left, the page in the
// middle, and "On this page" on the right at wide sizes.

export interface TocEntry {
  readonly id: string;
  readonly text: string;
  readonly level: number;
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Docs" className="flex flex-col gap-8 text-[15px]">
      {SECTIONS.map((section) => (
        <div key={section.title} className="flex flex-col gap-1">
          <span className="mb-1 px-3 font-display text-[15px] font-bold text-foreground">
            {section.title}
          </span>
          {section.pages.map((page) => {
            const to: string = page.slug === "introduction" ? "/docs" : `/docs/${page.slug}`;
            const active =
              path === to || (page.slug === "decisions" && path.startsWith("/docs/decisions"));
            return (
              <Link
                key={page.slug}
                to={to}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3 py-1.5 transition-colors ${
                  active
                    ? "bg-primary font-semibold text-primary-foreground"
                    : "text-muted-foreground hover:bg-card hover:text-foreground"
                }`}
              >
                {page.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
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
    <nav aria-label="On this page" className="flex flex-col gap-1 text-[14px]">
      <span className="mb-2 font-display text-[15px] font-bold">On this page</span>
      {toc.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          className={`py-1 transition-colors ${t.level === 3 ? "pl-3" : ""} ${
            current === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.text}
        </a>
      ))}
    </nav>
  );
}

export function DocsFrame({
  slug,
  title,
  summary,
  toc = [],
  children,
}: {
  slug: string;
  title: string;
  summary: string;
  toc?: readonly TocEntry[];
  children: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const { prev, next } = neighbours(slug);
  const hrefOf = (s: string): string => (s === "introduction" ? "/docs" : `/docs/${s}`);

  useEffect(() => {
    document.title = `${title} · One-for-All docs`;
  }, [title]);

  return (
    <div className="min-h-svh">
      <header className="gutter sticky top-0 z-30 flex h-16 items-center justify-between bg-background">
        <div className="flex items-center gap-4">
          <Link to="/" aria-label="One-for-All, home">
            <Wordmark />
          </Link>
          <Link
            to="/docs"
            className="hidden rounded-full bg-card px-3 py-1 text-[14px] text-muted-foreground sm:block"
          >
            Docs
          </Link>
        </div>
        <div className="flex items-center gap-2 text-[15px]">
          <a
            href={REPO_URL}
            className="rounded-full bg-primary px-4 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.97]"
          >
            GitHub
          </a>
          <button
            type="button"
            onClick={() => setMenu(!menu)}
            aria-expanded={menu}
            className="rounded-full bg-card px-4 py-2 lg:hidden"
          >
            {menu ? "Close" : "Contents"}
          </button>
        </div>
      </header>

      {menu && (
        <div className="gutter fixed inset-x-0 top-16 bottom-0 z-20 overflow-y-auto bg-background py-6 lg:hidden">
          <Sidebar onNavigate={() => setMenu(false)} />
        </div>
      )}

      <div className="gutter mx-auto grid max-w-[1440px] gap-12 pt-8 pb-32 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_200px]">
        <aside className="sticky top-24 hidden max-h-[calc(100svh-7rem)] self-start overflow-y-auto pb-8 lg:block">
          <Sidebar />
        </aside>

        <main className="min-w-0">
          <article className="mx-auto max-w-[760px]">
            <header className="flex flex-col gap-4 pb-6">
              <h1 className="text-[clamp(40px,5vw,72px)] leading-[0.98] font-extrabold tracking-[-0.045em]">
                {title}
              </h1>
              <p className="text-[19px] leading-relaxed text-muted-foreground">{summary}</p>
            </header>
            {children}
            <nav aria-label="More pages" className="mt-20 grid gap-3 sm:grid-cols-2">
              {prev ? (
                <Link
                  to={hrefOf(prev.slug)}
                  className="flex flex-col gap-1 rounded-[20px] bg-card px-5 py-4 transition-colors hover:bg-popover"
                >
                  <span className="text-[14px] text-muted-foreground">Before</span>
                  <span className="font-display text-[20px] font-bold">{prev.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link
                  to={hrefOf(next.slug)}
                  className="flex flex-col gap-1 rounded-[20px] bg-card px-5 py-4 text-right transition-colors hover:bg-popover"
                >
                  <span className="text-[14px] text-muted-foreground">Next</span>
                  <span className="font-display text-[20px] font-bold">{next.title}</span>
                </Link>
              )}
            </nav>
          </article>
        </main>

        <aside className="sticky top-24 hidden self-start xl:block">
          <OnThisPage toc={toc} />
        </aside>
      </div>
    </div>
  );
}
