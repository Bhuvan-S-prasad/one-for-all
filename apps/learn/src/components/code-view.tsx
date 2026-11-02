import { Link } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import type { Index } from "@/lib/data";
import { highlight } from "@/lib/highlight";
import { fileHref, repoFile, symbolHref } from "@/lib/links";

// Source code to read (ADR-0051): line numbers, light highlighting, and the
// names of calls as links to what they reach, from the index's call graph.

export function CodeView(props: {
  index: Index;
  path: string;
  source: string;
  /** 1-based, inclusive; the whole file by default. */
  start?: number;
  end?: number;
  /** A caption above the code. */
  title?: string | null;
  /** Lines to mark, e.g. from the address. */
  mark?: number | null;
  /** The file view gives every line an anchor (`#L120`). */
  anchors?: boolean;
}) {
  const { index, path, source } = props;
  const all = useMemo(() => highlight(source), [source]);
  const start = Math.max(1, props.start ?? 1);
  const end = Math.min(all.length, props.end ?? all.length);

  // Names called from this file, and where each one goes: per line, and for
  // a name that only ever reaches one place, everywhere in the file.
  const links = useMemo(() => {
    const atLine = new Map<string, string>();
    const anywhere = new Map<string, Set<string>>();
    for (const e of index.calls) {
      const fromFile = e.from.split("#")[0];
      if (fromFile !== path) continue;
      atLine.set(`${e.line}:${e.name}`, e.to);
      const short = e.name.split(".").pop()!;
      (anywhere.get(short) ?? anywhere.set(short, new Set()).get(short)!).add(e.to);
    }
    return { atLine, anywhere };
  }, [index, path]);

  useEffect(() => {
    if (!props.anchors || !props.mark) return;
    document.getElementById(`L${props.mark}`)?.scrollIntoView({ block: "center" });
  }, [props.anchors, props.mark]);

  return (
    <figure className="my-6 overflow-hidden rounded-[16px] border border-border bg-card">
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-[13px]">
        {props.title && <span className="font-semibold text-foreground">{props.title}</span>}
        <Link
          to={fileHref(path, start > 1 ? start : undefined)}
          className="font-mono text-muted-foreground hover:text-foreground"
        >
          {path}
          {start > 1 || end < all.length ? `:${start}–${end}` : ""}
        </Link>
        <a
          href={repoFile(path, start > 1 ? start : undefined)}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          GitHub ↗
        </a>
      </figcaption>
      <div className="overflow-x-auto">
        <pre className="py-3 font-mono text-[13px] leading-[1.65]">
          {all.slice(start - 1, end).map((tokens, i) => {
            const n = start + i;
            return (
              <div
                key={n}
                id={props.anchors ? `L${n}` : undefined}
                className={`flex pr-4 ${props.mark === n ? "bg-primary/12" : ""}`}
              >
                <span className="w-14 shrink-0 pr-4 text-right text-muted-foreground/60 select-none">
                  {n}
                </span>
                <code className="whitespace-pre">
                  {tokens.map((t, j) => {
                    const to =
                      t.kind === "plain" || t.kind === "type"
                        ? (links.atLine.get(`${n}:${t.text}`) ??
                          (links.anywhere.get(t.text)?.size === 1
                            ? [...links.anywhere.get(t.text)!][0]
                            : undefined))
                        : undefined;
                    if (to && index.symbols[to]) {
                      return (
                        <Link
                          key={j}
                          to={symbolHref(to)}
                          title={`Go to ${index.symbols[to].name}`}
                          className={`${t.kind === "type" ? "tok-type" : ""} underline decoration-primary/40 decoration-1 underline-offset-[3px] hover:decoration-primary`}
                        >
                          {t.text}
                        </Link>
                      );
                    }
                    return t.kind === "plain" ? (
                      <span key={j}>{t.text}</span>
                    ) : (
                      <span key={j} className={`tok-${t.kind}`}>
                        {t.text}
                      </span>
                    );
                  })}
                </code>
              </div>
            );
          })}
        </pre>
      </div>
    </figure>
  );
}
