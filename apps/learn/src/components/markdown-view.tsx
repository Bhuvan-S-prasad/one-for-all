import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { CodeView } from "@/components/code-view";
import { FlowDiagram, LayersDiagram, SequenceDiagram } from "@/components/diagrams";
import { CallsPanel, EndpointList, Loading, TableCard } from "@/components/panels";
import { useSource, type Index } from "@/lib/data";
import {
  decisionHref,
  fileHref,
  packageHref,
  pageHref,
  repoFile,
  routeHref,
  symbolHref,
  tableHref,
} from "@/lib/links";
import { inlineText, type Block, type Inline } from "@/lib/markdown";
import { narrow, parseBlockRef, splitApiRef, splitCodeRef } from "@/lib/refs";

// Renders the pages' Markdown as React, never as HTML (ADR-0051). References
// to the code (src/lib/refs.ts) become links and live panels from the index:
// excerpts, callers and callees, tables, endpoints. The index script has
// already checked that each one resolves.

export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

/** Where a link should go: inside the app, or out to GitHub or the web. */
function resolveHref(href: string): { internal: boolean; to: string } {
  const scheme = /^(code|table|api|adr|page|pkg):(.+)$/.exec(href);
  if (scheme) {
    const [, kind, ref] = scheme as unknown as [string, string, string];
    if (kind === "code") {
      const { path, symbol } = splitCodeRef(ref);
      return { internal: true, to: symbol ? symbolHref(`${path}#${symbol}`) : fileHref(path) };
    }
    if (kind === "table") return { internal: true, to: tableHref(ref) };
    if (kind === "api") {
      const { method, path } = splitApiRef(ref);
      return { internal: true, to: routeHref(method, path) };
    }
    if (kind === "adr") return { internal: true, to: decisionHref(ref) };
    if (kind === "page") return { internal: true, to: pageHref(ref) };
    return { internal: true, to: packageHref(ref) };
  }
  if (/^https?:|^mailto:/.test(href)) return { internal: false, to: href };
  if (href.startsWith("#")) return { internal: false, to: href };
  // A decision record linking to another: "0032-delegation….md" or "../adr/0032-….md".
  const adr = /(?:^|\/)(\d{4})-[\w-]+\.md(#.*)?$/.exec(href);
  if (adr) return { internal: true, to: decisionHref(adr[1]!) };
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

/** A ```code block: a symbol or a file, maybe narrowed to lines between two anchors. */
function CodeExcerpt({ index, body }: { index: Index; body: string }) {
  const block = parseBlockRef(body);
  const { path, symbol } = splitCodeRef(block.ref);
  const file = index.files[path];
  const sym = symbol ? index.symbols[`${path}#${symbol}`] : undefined;
  const { data: source } = useSource(file?.pkg ?? null);
  if (!file) return <p className="text-destructive">No file {path} in the index.</p>;
  if (!source) return <Loading what="the code" />;
  const text = source[path] ?? "";
  const span = narrow(text, sym?.line ?? 1, sym?.end ?? file.lines, block.from, block.to);
  if (!span) return <p className="text-destructive">The excerpt's anchors aren't in {path}.</p>;
  return (
    <CodeView
      index={index}
      path={path}
      source={text}
      start={span.start}
      end={span.end}
      title={block.title ?? (sym ? sym.name : null)}
    />
  );
}

function BlockView(props: { block: Block; ids: Map<Block, string>; index: Index }): ReactNode {
  const { block, ids, index } = props;
  switch (block.type) {
    case "heading": {
      const id = ids.get(block);
      const text = <InlineView nodes={block.children} />;
      if (block.level <= 2)
        return (
          <h2
            id={id}
            className="mt-14 mb-4 scroll-mt-24 text-[clamp(24px,2.6vw,32px)] leading-[1.1] font-bold text-foreground"
          >
            {text}
          </h2>
        );
      if (block.level === 3)
        return (
          <h3
            id={id}
            className="mt-9 mb-3 scroll-mt-24 text-[20px] leading-tight font-bold text-foreground"
          >
            {text}
          </h3>
        );
      return <h4 className="mt-7 mb-2 text-[17px] font-semibold text-foreground">{text}</h4>;
    }
    case "paragraph":
      return (
        <p className="my-4 max-w-[72ch]">
          <InlineView nodes={block.children} />
        </p>
      );
    case "code": {
      const ref = parseBlockRef(block.text).ref;
      switch (block.lang) {
        case "flow":
          return <FlowDiagram text={block.text} />;
        case "layers":
          return <LayersDiagram text={block.text} />;
        case "sequence":
          return <SequenceDiagram text={block.text} />;
        case "code":
          return <CodeExcerpt index={index} body={block.text} />;
        case "calls": {
          const { path, symbol } = splitCodeRef(ref);
          return <CallsPanel index={index} id={`${path}#${symbol}`} />;
        }
        case "table": {
          const table = index.tableByName.get(ref);
          return table ? <TableCard index={index} table={table} /> : null;
        }
        case "endpoints":
          return (
            <EndpointList
              index={index}
              routes={index.routes.filter((r) => r.path.startsWith(ref))}
            />
          );
      }
      return (
        <pre className="my-6 overflow-x-auto rounded-[16px] bg-card p-5 font-mono text-[13px] leading-relaxed text-foreground">
          <code>{block.text}</code>
        </pre>
      );
    }
    case "quote":
      return (
        <blockquote className="my-6 rounded-[16px] border-l-4 border-primary/60 bg-card px-5 py-1 text-foreground">
          {block.children.map((b, i) => (
            <BlockView key={i} block={b} ids={ids} index={index} />
          ))}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-1.5 marker:text-muted-foreground">
          {item.children.map((b, j) =>
            b.type === "paragraph" ? (
              <span key={j} className="block">
                <InlineView nodes={b.children} />
              </span>
            ) : (
              <BlockView key={j} block={b} ids={ids} index={index} />
            ),
          )}
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="my-4 flex list-decimal flex-col gap-1.5 pl-6">
          {items}
        </ol>
      ) : (
        <ul className="my-4 flex list-disc flex-col gap-1.5 pl-6">{items}</ul>
      );
    }
    case "table":
      return (
        <div className="my-6 overflow-x-auto rounded-[16px] border border-border bg-card">
          <table className="w-full border-collapse text-[14.5px]">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th
                    key={i}
                    className="border-b border-border px-4 py-2.5 text-left align-bottom font-semibold whitespace-nowrap text-foreground"
                  >
                    <InlineView nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-border last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-4 py-2.5 align-top">
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
      return <hr className="my-10 border-border" />;
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

export function MarkdownView({ blocks, index }: { blocks: readonly Block[]; index: Index }) {
  const ids = headingIds(blocks);
  return (
    <div className="text-[16.5px] leading-[1.7] text-foreground/95">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} ids={ids} index={index} />
      ))}
    </div>
  );
}
