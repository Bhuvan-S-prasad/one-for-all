import { Check, Copy } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { inlineText, type Block, type Inline } from "@/lib/markdown";
import { sourceFor, type RunSource } from "@/lib/run-steps";
import { cn } from "@/lib/utils";

// Renders the tree from lib/markdown. Text only ever becomes React text, and
// links were filtered to http(s) and mailto when parsed (UX.08). A link to a
// page the run actually read becomes a numbered citation (UX.09).

/** Stable ids for headings, so a long answer's outline can link to them. */
export function headingId(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `h-${index}-${slug || "section"}`;
}

export function Cite({ source }: { source: RunSource }) {
  return (
    <span className="group/cite relative inline-block align-[2px]">
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`Source ${source.n}: ${source.title ?? source.host}`}
        className="mx-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[6px] bg-accent px-1 font-mono text-[10.5px] leading-none text-muted-foreground no-underline transition-colors outline-none hover:bg-primary hover:text-primary-foreground focus-visible:bg-primary focus-visible:text-primary-foreground"
      >
        {source.n}
      </a>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-2 w-72 -translate-x-1/2 rounded-[14px] border bg-popover p-3 text-left font-sans text-[13px] leading-snug opacity-0 shadow-2xl transition-opacity duration-150 group-focus-within/cite:visible group-focus-within/cite:opacity-100 group-hover/cite:visible group-hover/cite:opacity-100"
      >
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {source.host}
          <span className="eyebrow ml-auto rounded-full bg-success/15 px-1.5 py-0.5 text-[9.5px] text-success">
            Read
          </span>
        </span>
        <span className="mt-1 block font-semibold text-popover-foreground">
          {source.title ?? source.url}
        </span>
      </span>
    </span>
  );
}

function InlineNodes({
  nodes,
  sources,
}: {
  nodes: readonly Inline[];
  sources: readonly RunSource[];
}): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.text}</Fragment>;
      case "break":
        return <br key={i} />;
      case "code":
        return (
          <code
            key={i}
            className="rounded-[5px] bg-accent px-1.5 py-px font-mono text-[0.88em] break-words"
          >
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={i} className="font-semibold text-foreground">
            <InlineNodes nodes={node.children} sources={sources} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <InlineNodes nodes={node.children} sources={sources} />
          </em>
        );
      case "del":
        return (
          <del key={i} className="text-muted-foreground">
            <InlineNodes nodes={node.children} sources={sources} />
          </del>
        );
      case "link": {
        const source = sourceFor(sources, node.href);
        const bare =
          inlineText(node.children) === node.href.replace(/\/$/, "") ||
          inlineText(node.children) === node.href;
        // A bare address the agent read reads better as just its number.
        if (source && bare) return <Cite key={i} source={source} />;
        return (
          <Fragment key={i}>
            <a
              href={node.href}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                "text-highlight underline decoration-highlight/40 underline-offset-[3px] hover:decoration-highlight",
                bare && "break-all",
              )}
            >
              <InlineNodes nodes={node.children} sources={sources} />
            </a>
            {source && <Cite source={source} />}
          </Fragment>
        );
      }
    }
  });
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  };
  return (
    <div className="overflow-hidden rounded-[14px] border bg-[#0b0b0c] text-[#e4e4e0]">
      <div className="flex h-9 items-center justify-between border-b border-white/5 pr-1.5 pl-3.5">
        <span className="font-mono text-[11.5px] text-[#8a8a90]">{lang || "text"}</span>
        <button
          type="button"
          onClick={copy}
          className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-[#c8c8cc] outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-primary"
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
        <code>{text}</code>
      </pre>
    </div>
  );
}

const NUMERIC = /^[\s$€£¥]*[-+]?[\d.,]+\s*(%|[kKmMbB]|ms|s)?$/;

function Blocks({
  blocks,
  sources,
  counter,
}: {
  blocks: readonly Block[];
  sources: readonly RunSource[];
  counter: { n: number };
}): ReactNode {
  return blocks.map((block, i) => {
    switch (block.type) {
      case "heading": {
        const text = inlineText(block.children);
        const id = headingId(text, counter.n++);
        const inner = <InlineNodes nodes={block.children} sources={sources} />;
        if (block.level <= 2) {
          return (
            <h3
              key={i}
              id={id}
              className="mt-3 scroll-mt-24 text-[21px] leading-tight font-bold tracking-[-0.015em] first:mt-0"
            >
              {inner}
            </h3>
          );
        }
        return (
          <h4
            key={i}
            id={id}
            className={cn(
              "mt-2 scroll-mt-24 font-display leading-snug font-semibold first:mt-0",
              block.level === 3 ? "text-[17px]" : "text-[15px]",
            )}
          >
            {inner}
          </h4>
        );
      }
      case "paragraph":
        return (
          <p key={i}>
            <InlineNodes nodes={block.children} sources={sources} />
          </p>
        );
      case "code":
        return <CodeBlock key={i} lang={block.lang} text={block.text} />;
      case "rule":
        return <hr key={i} className="my-1 border-border" />;
      case "quote":
        return (
          <blockquote
            key={i}
            className="flex flex-col gap-2 rounded-[14px] border bg-accent/40 px-4 py-3 text-[0.95em] text-foreground/90"
          >
            <Blocks blocks={block.children} sources={sources} counter={counter} />
          </blockquote>
        );
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag
            key={i}
            start={block.ordered && block.start !== 1 ? block.start : undefined}
            className={cn(
              "flex flex-col gap-1.5 pl-6 marker:text-muted-foreground",
              block.ordered ? "list-decimal marker:font-mono marker:text-[0.85em]" : "list-disc",
            )}
          >
            {block.items.map((item, j) => {
              const tight = item.children.length === 1 && item.children[0]?.type === "paragraph";
              const body = tight ? (
                <InlineNodes
                  nodes={(item.children[0] as Extract<Block, { type: "paragraph" }>).children}
                  sources={sources}
                />
              ) : (
                <div className="flex flex-col gap-2">
                  <Blocks blocks={item.children} sources={sources} counter={counter} />
                </div>
              );
              if (item.checked === null) return <li key={j}>{body}</li>;
              return (
                <li key={j} className="flex list-none items-start gap-2 -ml-6">
                  <span
                    role="img"
                    aria-label={item.checked ? "Done" : "Not done"}
                    className={cn(
                      "mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-[5px] border",
                      item.checked && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {item.checked && <Check className="size-3" strokeWidth={3} aria-hidden />}
                  </span>
                  <span className={cn(item.checked && "text-muted-foreground line-through")}>
                    {body}
                  </span>
                </li>
              );
            })}
          </Tag>
        );
      }
      case "table":
        return (
          <div key={i} className="overflow-x-auto rounded-[14px] border">
            <table className="w-full border-collapse text-[14px] leading-snug">
              <thead>
                <tr>
                  {block.head.map((cell, j) => (
                    <th
                      key={j}
                      scope="col"
                      className={cn(
                        "eyebrow sticky top-0 border-b bg-muted px-3.5 py-2.5 text-left text-[10.5px] font-medium whitespace-nowrap text-muted-foreground",
                        block.align[j] === "right" && "text-right",
                        block.align[j] === "center" && "text-center",
                      )}
                    >
                      <InlineNodes nodes={cell} sources={sources} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className="border-b last:border-0">
                    {row.map((cell, j) => {
                      const numeric = NUMERIC.test(inlineText(cell));
                      return (
                        <td
                          key={j}
                          className={cn(
                            "px-3.5 py-2.5 align-top",
                            j === 0 && "font-semibold",
                            (block.align[j] === "right" || (block.align[j] === null && numeric)) &&
                              "text-right tabular-nums",
                            block.align[j] === "center" && "text-center",
                          )}
                        >
                          <InlineNodes nodes={cell} sources={sources} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** A reply's Markdown. `sources` turns links to pages the run read into citations. */
export function Markdown({
  blocks,
  sources = [],
  className,
}: {
  blocks: readonly Block[];
  sources?: readonly RunSource[];
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3 break-words", className)}>
      <Blocks blocks={blocks} sources={sources} counter={{ n: 0 }} />
    </div>
  );
}
