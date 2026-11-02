import { Link, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { Layout, PageTitle } from "@/components/layout";
import { headingIds, MarkdownView } from "@/components/markdown-view";
import { Loading, Missing } from "@/components/panels";
import { useIndex } from "@/lib/data";
import { inlineText, parseMarkdown } from "@/lib/markdown";
import { findPage, neighbours, SECTIONS } from "@/lib/pages";

// A written page (a chapter, a feature or a walkthrough), and each section's
// list of pages.

export function SectionIndex({ section }: { section: string }) {
  const s = SECTIONS.find((x) => x.key === section);
  if (!s) return <Missing>No such section.</Missing>;
  return (
    <Layout>
      <PageTitle title={s.title} lede={s.intro} />
      {s.pages.length === 0 && <p className="text-muted-foreground">Pages here are coming soon.</p>}
      <ol className="flex flex-col gap-3">
        {s.pages.map((p, i) => (
          <li key={p.slug}>
            <Link
              to={`/${s.key}/${p.slug}`}
              className="flex gap-4 rounded-[18px] border border-border bg-card p-4 hover:border-primary"
            >
              {s.key === "path" && (
                <span className="font-display text-[22px] font-bold text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
              )}
              <span className="flex flex-col gap-1">
                <span className="font-display text-[19px] font-bold">{p.title}</span>
                <span className="text-[14.5px] text-muted-foreground">{p.summary}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Layout>
  );
}

export function WrittenPage({ section }: { section: string }) {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const page = findPage(section, slug);
  const { data: index, error } = useIndex();
  const blocks = useMemo(() => (page ? parseMarkdown(page.body) : []), [page]);
  const toc = useMemo(() => {
    const ids = headingIds(blocks);
    return blocks.flatMap((b) =>
      b.type === "heading" && b.level <= 3 && ids.get(b)
        ? [{ id: ids.get(b)!, text: inlineText(b.children), level: b.level }]
        : [],
    );
  }, [blocks]);
  if (!page) return <Missing>There is no page called “{slug}”.</Missing>;
  const s = SECTIONS.find((x) => x.key === section)!;
  const { prev, next } = neighbours(page);
  const number = section === "path" ? s.pages.indexOf(page) + 1 : null;
  return (
    <Layout toc={toc}>
      <PageTitle
        eyebrow={number ? `${s.title} · chapter ${number}` : s.title}
        title={page.title}
        lede={page.summary}
      />
      {error && <p className="text-destructive">{error.message}</p>}
      {!index && !error && <Loading />}
      {index && <MarkdownView blocks={blocks} index={index} />}
      <nav
        aria-label="More pages"
        className="mt-16 grid gap-3 border-t border-border pt-8 sm:grid-cols-2"
      >
        {prev ? (
          <Link
            to={`/${section}/${prev.slug}`}
            className="flex flex-col rounded-[16px] bg-card px-4 py-3 hover:bg-popover"
          >
            <span className="text-[13px] text-muted-foreground">← Before</span>
            <span className="font-semibold">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link
            to={`/${section}/${next.slug}`}
            className="flex flex-col rounded-[16px] bg-card px-4 py-3 text-right hover:bg-popover"
          >
            <span className="text-[13px] text-muted-foreground">Next →</span>
            <span className="font-semibold">{next.title}</span>
          </Link>
        )}
      </nav>
    </Layout>
  );
}
