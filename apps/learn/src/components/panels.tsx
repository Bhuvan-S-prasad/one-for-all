import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Index } from "@/lib/data";
import type { CallEdge, RouteInfo, SymbolKind, TableInfo } from "@/lib/index-types";
import { fileHref, packageHref, routeHref, symbolHref, tableHref } from "@/lib/links";

// Pieces every page uses: a symbol as a link, its callers and callees, a
// table's columns, a list of endpoints.

const KIND_LABEL: Record<SymbolKind, string> = {
  function: "function",
  component: "component",
  class: "class",
  interface: "interface",
  type: "type",
  const: "constant",
  enum: "enum",
  method: "method",
  property: "property",
};

export function KindTag({ kind }: { kind: SymbolKind }) {
  return (
    <span className="eyebrow rounded-full bg-popover px-2 py-0.5 text-[10.5px] text-muted-foreground">
      {KIND_LABEL[kind]}
    </span>
  );
}

/** A symbol or a file as a link, with its package. */
export function SymbolLink({ index, id }: { index: Index; id: string }) {
  const s = index.symbols[id];
  if (!s) {
    // Top-level code in a file.
    return (
      <Link to={fileHref(id)} className="font-mono text-[13px] hover:text-primary">
        {id.split("/").pop()} <span className="text-muted-foreground">(file)</span>
      </Link>
    );
  }
  return (
    <Link to={symbolHref(id)} className="group inline-flex min-w-0 items-baseline gap-2">
      <span className="truncate font-mono text-[13.5px] text-foreground group-hover:text-primary">
        {s.name}
      </span>
      <span className="truncate text-[12px] text-muted-foreground">
        {s.pkg} · {s.file.split("/").pop()}
      </span>
    </Link>
  );
}

function EdgeList(props: {
  index: Index;
  edges: readonly CallEdge[];
  side: "from" | "to";
  empty: string;
}) {
  if (props.edges.length === 0) {
    return <p className="text-[14px] text-muted-foreground">{props.empty}</p>;
  }
  // By package, so the layers show.
  const groups = new Map<string, CallEdge[]>();
  for (const e of props.edges) {
    const id = e[props.side];
    const pkg = props.index.symbols[id]?.pkg ?? props.index.files[id]?.pkg ?? "?";
    (groups.get(pkg) ?? groups.set(pkg, []).get(pkg)!).push(e);
  }
  return (
    <div className="flex flex-col gap-3">
      {[...groups].map(([pkg, list]) => (
        <div key={pkg} className="flex flex-col gap-1">
          <Link
            to={packageHref(pkg)}
            className="eyebrow text-[11px] text-muted-foreground hover:text-foreground"
          >
            {pkg}
          </Link>
          <ul className="flex flex-col gap-1">
            {list.map((e) => (
              <li key={`${e.from}-${e.to}`} className="flex min-w-0 items-baseline gap-2">
                <SymbolLink index={props.index} id={e[props.side]} />
                {e.kind === "render" && (
                  <span className="text-[11.5px] text-muted-foreground">renders</span>
                )}
                {e.count > 1 && (
                  <span className="text-[11.5px] text-muted-foreground">×{e.count}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Who calls a symbol and what it calls, side by side. */
export function CallsPanel({ index, id }: { index: Index; id: string }) {
  const s = index.symbols[id];
  // A member's calls count for it; an interface's members are what gets called.
  const ids = [id, ...(s?.members ?? [])];
  const callers = ids.flatMap((x) => index.callsTo.get(x) ?? []);
  const callees = (index.callsFrom.get(id) ?? []).filter((e) => e.to !== id);
  return (
    <div className="my-6 grid gap-4 rounded-[16px] border border-border bg-card p-4 md:grid-cols-2">
      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="text-[15px] font-bold">Called by · {callers.length}</h3>
        <EdgeList
          index={index}
          edges={callers}
          side="from"
          empty="Nothing in the code calls it directly."
        />
      </section>
      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="text-[15px] font-bold">Calls · {callees.length}</h3>
        <EdgeList
          index={index}
          edges={callees}
          side="to"
          empty="It calls nothing else in the repository."
        />
      </section>
    </div>
  );
}

/** A table's columns, keys and constraints. */
export function TableCard({ index, table }: { index: Index; table: TableInfo }) {
  const fkByColumn = new Map<string, string>();
  for (const fk of table.foreignKeys) {
    // The last column of a (workspace_id, x) key is the one that points.
    const col = fk.columns.at(-1);
    if (col) fkByColumn.set(col, fk.table);
  }
  return (
    <section
      id={`table-${table.name}`}
      className="my-6 scroll-mt-24 overflow-hidden rounded-[16px] border border-border bg-card"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h3 className="font-mono text-[16px] font-bold">{table.name}</h3>
        {table.tenant && (
          <span className="text-[12px] text-muted-foreground">
            workspace-scoped · row-level security
          </span>
        )}
        <Link
          to={fileHref(table.file, table.line)}
          className="ml-auto font-mono text-[12px] text-muted-foreground hover:text-foreground"
        >
          {table.file.split("/").pop()}:{table.line}
        </Link>
      </header>
      {table.doc && <p className="px-4 pt-3 text-[14.5px]">{table.doc}</p>}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="text-left text-[12px] text-muted-foreground">
              <th className="px-4 py-2 font-medium">Column</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((c) => {
              const points = c.references ?? fkByColumn.get(c.column);
              const notes: ReactNode[] = [];
              if (c.primaryKey) notes.push("primary key");
              if (points && index.tableByName.has(points)) {
                notes.push(
                  <span key="ref">
                    →{" "}
                    <Link to={tableHref(points)} className="font-mono hover:text-primary">
                      {points}
                    </Link>
                  </span>,
                );
              }
              if (!c.notNull && !c.primaryKey) notes.push("optional");
              if (c.unique) notes.push("unique");
              if (c.defaultValue) notes.push(`default ${c.defaultValue}`);
              return (
                <tr key={c.key} className="border-t border-border align-top">
                  <td className="px-4 py-2 font-mono whitespace-nowrap text-foreground">
                    {c.column}
                  </td>
                  <td className="px-4 py-2 font-mono whitespace-nowrap text-muted-foreground">
                    {c.type}
                    {c.array ? "[]" : ""}
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap gap-x-2 text-muted-foreground">
                      {notes.map((n, i) => (
                        <span key={i}>{n}</span>
                      ))}
                    </span>
                    {c.doc && <span className="block text-foreground/90">{c.doc}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {table.constraints.length > 0 && (
        <p className="border-t border-border px-4 py-2.5 text-[12.5px] text-muted-foreground">
          {table.constraints.map((c) => `${c.kind} ${c.name}`).join(" · ")}
        </p>
      )}
    </section>
  );
}

const METHOD_TONE: Record<RouteInfo["method"], string> = {
  GET: "text-success",
  POST: "text-primary",
  PUT: "text-warning",
  PATCH: "text-warning",
  DELETE: "text-destructive",
};

/** Endpoints with what each does and where it is defined. */
export function EndpointList({ index, routes }: { index: Index; routes: readonly RouteInfo[] }) {
  return (
    <ul className="my-4 flex flex-col divide-y divide-border overflow-hidden rounded-[16px] border border-border bg-card">
      {routes.map((r) => (
        <li
          key={`${r.method} ${r.path}`}
          id={routeHref(r.method, r.path).split("#")[1]}
          className="grid scroll-mt-24 gap-x-4 gap-y-1 px-4 py-2.5 sm:grid-cols-[64px_1fr_auto]"
        >
          <span className={`font-mono text-[12.5px] font-semibold ${METHOD_TONE[r.method]}`}>
            {r.method}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="font-mono text-[13.5px] break-all text-foreground">{r.path}</span>
            {r.doc && <span className="text-[13.5px] text-muted-foreground">{r.doc}</span>}
          </span>
          <Link
            to={fileHref(r.file, r.line)}
            className="self-start font-mono text-[12px] text-muted-foreground hover:text-foreground"
          >
            {index.symbols[r.owner]?.name ?? r.file.split("/").pop()} · {r.file.split("/").pop()}:
            {r.line}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Loading({ what = "the code index" }: { what?: string }) {
  return (
    <p className="py-16 text-center text-muted-foreground" aria-busy="true">
      Loading {what}…
    </p>
  );
}

export function Missing({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[640px] py-20 text-center">
      <h1 className="text-[28px] font-bold">Not found</h1>
      <p className="mt-3 text-muted-foreground">{children}</p>
    </div>
  );
}
