import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { inlineText, type Block, type Inline } from "@/lib/markdown";
import { repoFile } from "@/lib/site";

// Renders the docs' Markdown as React, never as HTML. Two fenced languages
// draw diagrams: `flow` (a sequence of steps) and `layers` (a stack of bands).

export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

/** Where a link in a page or a decision record should go on the site. */
function resolveHref(href: string): { internal: boolean; to: string } {
  if (/^https?:|^mailto:/.test(href)) return { internal: false, to: href };
  if (href.startsWith("#")) return { internal: false, to: href };
  if (href.startsWith("/docs")) return { internal: true, to: href };
  // A decision record linking to another: "0032-delegation….md" or "../adr/0032-….md".
  const adr = /(?:^|\/)(\d{4})-[\w-]+\.md(#.*)?$/.exec(href);
  if (adr) return { internal: true, to: `/docs/decisions/${adr[1]}` };
  // Anything else in the repository opens on GitHub.
  const path = href.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
  const file =
    path.startsWith("architecture/") || path.startsWith("planning/") || path.startsWith("guides/")
      ? `docs/${path}`
      : path;
  return { internal: false, to: repoFile(file) };
}

function InlineView({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "break":
            return <br key={i} />;
          case "code":
            return (
              <code
                key={i}
                className="rounded-[6px] bg-popover px-1.5 py-0.5 font-mono text-[0.86em] text-foreground"
              >
                {n.text}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-foreground">
                <InlineView nodes={n.children} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <InlineView nodes={n.children} />
              </em>
            );
          case "del":
            return (
              <del key={i}>
                <InlineView nodes={n.children} />
              </del>
            );
          case "link": {
            const { internal, to } = resolveHref(n.href);
            const cls =
              "text-foreground underline decoration-primary/70 decoration-2 underline-offset-[3px] hover:decoration-primary";
            return internal ? (
              <Link key={i} to={to} className={cls}>
                <InlineView nodes={n.children} />
              </Link>
            ) : (
              <a
                key={i}
                href={to}
                className={cls}
                {...(to.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer noopener" })}
              >
                <InlineView nodes={n.children} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

/** `Title | text` per line; a leading `!` marks the step that matters most. */
function FlowDiagram({ text }: { text: string }) {
  const steps = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const strong = l.startsWith("!");
      const [title, ...rest] = (strong ? l.slice(1) : l).split("|");
      return { title: (title ?? "").trim(), text: rest.join("|").trim(), strong };
    });
  return (
    <ol className="my-8 flex flex-col" aria-label="Diagram">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-4 pb-5 last:pb-0">
          {i < steps.length - 1 && (
            <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-[2px] bg-popover" />
          )}
          <span
            aria-hidden
            className={`relative z-10 mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums ${
              s.strong ? "bg-primary text-primary-foreground" : "bg-popover text-foreground"
            }`}
          >
            {i + 1}
          </span>
          <div
            className={`flex min-w-0 flex-1 flex-col gap-1 rounded-[16px] px-4 py-3 ${
              s.strong ? "bg-primary/10" : "bg-card"
            }`}
          >
            <span className="font-semibold text-foreground">{s.title}</span>
            {s.text && <span className="text-[15px] text-muted-foreground">{s.text}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** `Name | what it owns | where` per line, drawn top to bottom. */
function LayersDiagram({ text }: { text: string }) {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|").map((c) => c.trim()));
  return (
    <div className="my-8 flex flex-col gap-1.5" role="list" aria-label="Diagram">
      {rows.map(([name, owns, where], i) => (
        <div
          key={i}
          role="listitem"
          className="grid gap-x-6 gap-y-1 rounded-[14px] px-4 py-3 sm:grid-cols-[200px_1fr]"
          style={{
            background: `color-mix(in oklab, var(--primary) ${Math.max(4, 22 - i * 2.2)}%, var(--card))`,
          }}
        >
          <span className="font-semibold text-foreground">{name}</span>
          <span className="text-[15px]">
            {owns}
            {where && (
              <code className="block font-mono text-[12.5px] text-muted-foreground">{where}</code>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function BlockView({ block, ids }: { block: Block; ids: Map<Block, string> }): ReactNode {
  switch (block.type) {
    case "heading": {
      const id = ids.get(block);
      const text = <InlineView nodes={block.children} />;
      if (block.level <= 2)
        return (
          <h2
            id={id}
            className="mt-16 mb-5 scroll-mt-24 text-[clamp(28px,3vw,38px)] leading-[1.08] font-bold text-foreground"
          >
            {text}
          </h2>
        );
      if (block.level === 3)
        return (
          <h3
            id={id}
            className="mt-10 mb-3 scroll-mt-24 text-[22px] leading-tight font-bold text-foreground"
          >
            {text}
          </h3>
        );
      return <h4 className="mt-8 mb-2 text-[18px] font-semibold text-foreground">{text}</h4>;
    }
    case "paragraph":
      return (
        <p className="my-4 max-w-[68ch]">
          <InlineView nodes={block.children} />
        </p>
      );
    case "code":
      if (block.lang === "flow") return <FlowDiagram text={block.text} />;
      if (block.lang === "layers") return <LayersDiagram text={block.text} />;
      return (
        <pre className="my-6 overflow-x-auto rounded-[16px] bg-card p-5 font-mono text-[13.5px] leading-relaxed text-foreground">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote className="my-6 rounded-[16px] bg-card px-5 py-1 text-foreground">
          {block.children.map((b, i) => (
            <BlockView key={i} block={b} ids={ids} />
          ))}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-1.5 marker:text-muted-foreground">
          {item.checked !== null && (
            <span
              role="img"
              aria-label={item.checked ? "Done" : "Not done"}
              className={`mr-2 inline-block size-3.5 translate-y-[2px] rounded-[4px] ${
                item.checked ? "bg-primary" : "bg-popover"
              }`}
            />
          )}
          {item.children.map((b, j) =>
            b.type === "paragraph" ? (
              <span key={j} className="block">
                <InlineView nodes={b.children} />
              </span>
            ) : (
              <BlockView key={j} block={b} ids={ids} />
            ),
          )}
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="my-4 flex list-decimal flex-col gap-2 pl-6">
          {items}
        </ol>
      ) : (
        <ul className="my-4 flex list-disc flex-col gap-2 pl-6">{items}</ul>
      );
    }
    case "table":
      return (
        <div className="my-6 overflow-x-auto rounded-[16px] bg-card">
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th
                    key={i}
                    /* taste-skill-ignore: a real table */ className="border-b border-border px-4 py-3 text-left align-bottom font-semibold whitespace-nowrap text-foreground"
                  >
                    <InlineView nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr
                  key={r}
                  /* taste-skill-ignore: a real table */ className="border-b border-border last:border-0"
                >
                  {row.map((cell, c) => (
                    <td key={c} className="px-4 py-3 align-top">
                      <InlineView nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <div className="my-12 h-2" aria-hidden />;
  }
}

/** Ids for every heading of levels 2 and 3, unique within the page. */
export function headingIds(blocks: readonly Block[]): Map<Block, string> {
  const ids = new Map<Block, string>();
  const used = new Map<string, number>();
  for (const b of blocks) {
    if (b.type !== "heading" || b.level > 3) continue;
    const base = headingSlug(inlineText(b.children)) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    ids.set(b, n ? `${base}-${n}` : base);
  }
  return ids;
}

export function MarkdownView({ blocks }: { blocks: readonly Block[] }) {
  const ids = headingIds(blocks);
  return (
    <div className="text-[17px] leading-[1.7] text-foreground">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ids={ids} />
      ))}
    </div>
  );
}
