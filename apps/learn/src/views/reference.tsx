import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, type ReactNode } from "react";
import { Layout, PageTitle } from "@/components/layout";
import { MarkdownView } from "@/components/markdown-view";
import { EndpointList, Loading, Missing, SymbolLink, TableCard } from "@/components/panels";
import { useIndex, type Index } from "@/lib/data";
import { decisionById, DECISIONS } from "@/lib/decisions";
import { fileHref, packageHref, symbolHref, tableHref } from "@/lib/links";
import { parseMarkdown } from "@/lib/markdown";
import { SECTIONS } from "@/lib/pages";

// The reference pages: the data model, the endpoints, the background jobs
// and their events, the agents' tools, the decisions, and search. Each opens
// with a short explanation of the idea, then lists what the index found.

function WithIndex({ children }: { children: (index: Index) => ReactNode }) {
  const { data: index, error } = useIndex();
  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!index) return <Loading />;
  return <>{children(index)}</>;
}

/** Scroll to `#…` once the list it points into has rendered. */
function useHashScroll(ready: boolean) {
  useEffect(() => {
    if (!ready || !location.hash) return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [ready]);
}

function Intro({ children }: { children: ReactNode }) {
  return (
    <div className="mb-10 flex max-w-[72ch] flex-col gap-3 text-[16px] text-foreground/90">
      {children}
    </div>
  );
}

export function DataModel() {
  const { data } = useIndex();
  useHashScroll(!!data);
  return (
    <Layout wide>
      <div className="max-w-[1040px]">
        <PageTitle eyebrow="Reference" title="Data model" />
        <Intro>
          <p>
            Everything One-for-All keeps lives in <strong>Postgres</strong>: agents, chats and
            messages, runs and their event logs, memory (with <code>pgvector</code> for similarity
            search), approvals, connected apps, routines. The tables are declared in TypeScript with{" "}
            <strong>Drizzle</strong> in{" "}
            <Link to={packageHref("db")} className="underline decoration-primary/60">
              packages/db/src/schema
            </Link>
            ; a migration (SQL in <code>packages/db/migrations</code>) is generated from them, and
            the row-level security policies are added by hand.
          </p>
          <p>
            <strong>Every table belongs to a workspace.</strong> It has a <code>workspace_id</code>,
            and Postgres row-level security only lets a query see rows of the workspace set for that
            connection (hard rule 3). Code reaches the database only through repository functions
            that take a <code>TenantContext</code>, which sets it. Foreign keys pair the workspace
            with the ID, so a row can never point into another workspace.
          </p>
          <p>
            Below: each table with its columns, what they point at, and its constraints, read from
            the schema.
          </p>
        </Intro>
        <WithIndex>
          {(index) => {
            const referencedBy = new Map<string, Set<string>>();
            for (const t of index.tables) {
              for (const target of [
                ...t.foreignKeys.map((f) => f.table),
                ...t.columns.flatMap((c) => c.references ?? []),
              ]) {
                if (target === t.name) continue;
                (referencedBy.get(target) ?? referencedBy.set(target, new Set()).get(target)!).add(
                  t.name,
                );
              }
            }
            const byFile = new Map<string, typeof index.tables>();
            for (const t of index.tables) {
              const f = t.file.split("/").pop()!.replace(/\.ts$/, "");
              byFile.set(f, [...(byFile.get(f) ?? []), t]);
            }
            return (
              <>
                <nav aria-label="Tables" className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {[...byFile].map(([file, list]) => (
                    <div key={file} className="rounded-[16px] bg-card p-4">
                      <h2 className="mb-2 font-mono text-[13px] text-muted-foreground">
                        schema/{file}.ts
                      </h2>
                      <ul className="flex flex-col gap-1">
                        {list.map((t) => (
                          <li key={t.name}>
                            <a
                              href={`#table-${t.name}`}
                              className="font-mono text-[14px] hover:text-primary"
                            >
                              {t.name}
                            </a>
                            {referencedBy.get(t.name)?.size ? (
                              <span className="ml-2 text-[12px] text-muted-foreground">
                                ← {referencedBy.get(t.name)!.size}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </nav>
                {index.tables.map((t) => (
                  <div key={t.name}>
                    <TableCard index={index} table={t} />
                    {referencedBy.get(t.name)?.size ? (
                      <p className="-mt-3 mb-8 px-1 text-[13px] text-muted-foreground">
                        Pointed at by:{" "}
                        {[...referencedBy.get(t.name)!].sort().map((r, i) => (
                          <span key={r}>
                            {i > 0 && ", "}
                            <a
                              href={`#table-${r}`}
                              className="font-mono text-foreground hover:text-primary"
                            >
                              {r}
                            </a>
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                ))}
                <h2 id="enums" className="mt-14 mb-4 text-[26px] font-bold">
                  Enums
                </h2>
                <p className="mb-4 max-w-[70ch] text-muted-foreground">
                  Postgres types that allow only a fixed set of values, so a bad status can't be
                  stored.
                </p>
                <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
                  {index.enums.map((e) => (
                    <li key={e.name} className="flex flex-col gap-1 px-4 py-2.5">
                      <span className="flex items-baseline gap-3">
                        <span className="font-mono text-[14px] font-semibold">{e.name}</span>
                        <Link
                          to={fileHref(e.file, e.line)}
                          className="ml-auto font-mono text-[12px] text-muted-foreground hover:text-foreground"
                        >
                          {e.file.split("/").pop()}:{e.line}
                        </Link>
                      </span>
                      <span className="font-mono text-[13px] text-muted-foreground">
                        {e.values.join(" · ") || "(from a shared list)"}
                      </span>
                      {e.doc && <span className="text-[13.5px]">{e.doc}</span>}
                    </li>
                  ))}
                </ul>
              </>
            );
          }}
        </WithIndex>
      </div>
    </Layout>
  );
}

export function Api() {
  const { data } = useIndex();
  useHashScroll(!!data);
  return (
    <Layout wide>
      <div className="max-w-[1040px]">
        <PageTitle eyebrow="Reference" title="API endpoints" />
        <Intro>
          <p>
            The web app talks to the server over HTTP: a <strong>Hono</strong> app in{" "}
            <Link to={packageHref("api")} className="underline decoration-primary/60">
              apps/api
            </Link>
            , listening on <code>127.0.0.1</code> only. Each area has its own router (a function
            returning a Hono app), mounted under <code>/api</code> in <code>app.ts</code>.
          </p>
          <p>
            Every request goes through the same middleware first: security headers, a body size
            limit, the Origin check against cross-site requests, the session cookie (Better Auth)
            and the workspace it belongs to. Request and response bodies are checked against zod
            schemas from <code>@ofa/contracts</code>, the same ones the web app uses, so both sides
            agree on every shape. The API never runs an agent itself: it stores the request and
            hands the work to the orchestrator (hard rule 1). Live updates come back over a
            WebSocket at <code>/api/ws</code>.
          </p>
        </Intro>
        <WithIndex>
          {(index) => {
            const groups = new Map<string, typeof index.routes>();
            for (const r of index.routes) {
              groups.set(r.owner, [...(groups.get(r.owner) ?? []), r]);
            }
            return [...groups].map(([owner, routes]) => (
              <section key={owner} className="mb-10">
                <h2 className="mb-1 flex flex-wrap items-baseline gap-3 text-[22px] font-bold">
                  <span className="font-mono">
                    {routes[0]!.path.split("/").slice(0, 3).join("/")}
                  </span>
                  <SymbolLink index={index} id={owner} />
                </h2>
                <EndpointList index={index} routes={routes} />
              </section>
            ));
          }}
        </WithIndex>
      </div>
    </Layout>
  );
}

export function Jobs() {
  return (
    <Layout wide>
      <div className="max-w-[1040px]">
        <PageTitle eyebrow="Reference" title="Jobs and events" />
        <Intro>
          <p>
            Agent work can take minutes or wait a day for an approval, so it doesn't run inside an
            HTTP request. The API sends an <strong>event</strong> (for example{" "}
            <code>agent/message.received</code>) to <strong>Inngest</strong>, which starts the{" "}
            <strong>function</strong> listening for it. Functions are written in{" "}
            <Link to={packageHref("orchestrator")} className="underline decoration-primary/60">
              packages/orchestrator
            </Link>
            .
          </p>
          <p>
            Inngest functions are <strong>durable</strong>: the work is split into steps (
            <code>step.run</code>), each result is saved, and after a crash or a long wait the
            function replays from the top, skipping the steps that already ran. That is why every
            side effect lives inside a step (hard rule 6). Concurrency keys keep one run per agent
            and per chat; <code>cancelOn</code> stops a run when someone presses Stop.
          </p>
        </Intro>
        <WithIndex>
          {(index) => (
            <>
              <h2 className="mb-4 text-[24px] font-bold">Functions</h2>
              <ul className="mb-12 flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
                {index.jobs.map((j) => (
                  <li
                    key={j.id}
                    className="grid gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[200px_1fr_auto]"
                  >
                    <span className="flex flex-col">
                      <span className="font-mono text-[14px] font-semibold">{j.id}</span>
                      <span className="text-[13px] text-muted-foreground">{j.name}</span>
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      {j.triggers.map((t) => (
                        <span
                          key={t}
                          className="h-fit rounded-full bg-popover px-2.5 py-0.5 font-mono text-[12.5px]"
                        >
                          {t.startsWith("cron") ? "⏱ " : "← "}
                          {t}
                        </span>
                      ))}
                    </span>
                    <Link
                      to={fileHref(j.file, j.line)}
                      className="font-mono text-[12px] text-muted-foreground hover:text-foreground"
                    >
                      {j.file.split("/").pop()}:{j.line}
                    </Link>
                  </li>
                ))}
              </ul>
              <h2 className="mb-4 text-[24px] font-bold">Events</h2>
              <p className="mb-4 max-w-[70ch] text-muted-foreground">
                Named <code>domain/noun.verb</code>. Their payloads are zod schemas in{" "}
                <code>packages/contracts/src/events.ts</code> and carry IDs only; functions load the
                rest inside their steps.
              </p>
              <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
                {index.events.map((e) => {
                  const starts = index.jobs.filter((j) => j.triggers.includes(e.name));
                  return (
                    <li key={e.key} className="flex flex-col gap-1 px-4 py-3">
                      <span className="flex flex-wrap items-baseline gap-3">
                        <span className="font-mono text-[14px] font-semibold">{e.name}</span>
                        {starts.map((j) => (
                          <span key={j.id} className="text-[12.5px] text-muted-foreground">
                            starts <span className="font-mono text-foreground">{j.id}</span>
                          </span>
                        ))}
                        <Link
                          to={symbolHref(`${e.file}#INNGEST_EVENTS.${e.key}`)}
                          className="ml-auto font-mono text-[12px] text-muted-foreground hover:text-foreground"
                        >
                          {e.key}
                        </Link>
                      </span>
                      {e.doc && <span className="text-[14px] text-foreground/90">{e.doc}</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </WithIndex>
      </div>
    </Layout>
  );
}

export function Tools() {
  const { data } = useIndex();
  useHashScroll(!!data);
  return (
    <Layout wide>
      <div className="max-w-[1040px]">
        <PageTitle eyebrow="Reference" title="Agent tools" />
        <Intro>
          <p>
            An agent acts through <strong>tools</strong>: functions the model may ask to call, each
            with a name, a description the model reads, and a zod schema for its arguments. They are
            defined with <code>defineTool</code> in{" "}
            <Link to={packageHref("tools")} className="underline decoration-primary/60">
              packages/tools
            </Link>
            ; apps connected over MCP add more at run time.
          </p>
          <p>
            A tool never runs straight from the model. The <strong>executor</strong> checks the
            arguments against the schema, asks the <strong>policy engine</strong> for a verdict
            (allow, ask a person, or deny; the strictest rule wins), records the call with an
            idempotency key so a retry can't do it twice, and only then runs it, adding any
            credentials at that moment and nowhere else (hard rules 4 and 5).
          </p>
        </Intro>
        <WithIndex>
          {(index) => {
            const groups = new Map<string, typeof index.tools>();
            for (const t of index.tools) {
              const g = t.name.includes(".") ? t.name.split(".")[0]! : "platform";
              groups.set(g, [...(groups.get(g) ?? []), t]);
            }
            return [...groups].map(([g, list]) => (
              <section key={g} className="mb-8">
                <h2 className="mb-3 font-mono text-[20px] font-bold">
                  {g === "platform" ? "Platform tools" : `${g}.*`}
                </h2>
                <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
                  {list.map((t) => (
                    <li
                      key={t.name}
                      id={`tool-${t.name}`}
                      className="flex scroll-mt-24 flex-col gap-1 px-4 py-3"
                    >
                      <span className="flex flex-wrap items-baseline gap-3">
                        <span className="font-mono text-[14px] font-semibold">{t.name}</span>
                        <Link
                          to={fileHref(t.file, t.line)}
                          className="ml-auto font-mono text-[12px] text-muted-foreground hover:text-foreground"
                        >
                          {t.file.split("/").pop()}:{t.line}
                        </Link>
                      </span>
                      <span className="text-[14px] text-foreground/90">
                        {t.description || "Its description is built at run time; see the code."}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ));
          }}
        </WithIndex>
      </div>
    </Layout>
  );
}

export function Decisions() {
  return (
    <Layout>
      <PageTitle
        eyebrow="Reference"
        title="Decisions"
        lede="Architecture decision records: each one says what was decided, why, and what was considered instead. When code looks surprising, the reason is usually here."
      />
      <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
        {DECISIONS.map((d) => (
          <li key={d.id}>
            <Link to={`/decisions/${d.id}`} className="flex gap-4 px-4 py-3 hover:bg-popover">
              <span className="font-mono text-[13px] text-muted-foreground">{d.id}</span>
              <span className="flex flex-col">
                <span className="font-semibold">{d.title}</span>
                <span className="text-[13px] text-muted-foreground">
                  {d.area} · {d.status}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Layout>
  );
}

export function Decision() {
  const { id } = useParams({ strict: false }) as { id: string };
  const d = decisionById.get(id);
  const { data: index } = useIndex();
  const blocks = useMemo(() => parseMarkdown(d?.body ?? ""), [d]);
  if (!d) return <Missing>No decision record {id}.</Missing>;
  return (
    <Layout>
      <PageTitle eyebrow={`ADR-${d.id} · ${d.area} · ${d.date}`} title={d.title} lede={d.status} />
      {index ? <MarkdownView blocks={blocks} index={index} /> : <Loading />}
    </Layout>
  );
}

/** Search across symbols, files, tables, endpoints, tools and pages. */
export function Search() {
  const { q = "" } = useSearch({ strict: false }) as { q?: string };
  const needle = q.toLowerCase();
  return (
    <Layout>
      <PageTitle eyebrow="Search" title={`“${q}”`} />
      <WithIndex>
        {(index) => {
          const score = (name: string) => {
            const n = name.toLowerCase();
            return n === needle ? 0 : n.startsWith(needle) ? 1 : n.includes(needle) ? 2 : -1;
          };
          const symbols = Object.values(index.symbols)
            .map((s) => ({ s, rank: score(s.name.split(".").pop()!) }))
            .filter((x) => x.rank >= 0)
            .sort(
              (a, b) =>
                a.rank - b.rank ||
                Number(b.s.exported) - Number(a.s.exported) ||
                a.s.name.length - b.s.name.length,
            )
            .slice(0, 40);
          const files = Object.keys(index.files)
            .filter((f) => f.toLowerCase().includes(needle))
            .slice(0, 20);
          const tables = index.tables.filter((t) => t.name.includes(needle));
          const routes = index.routes
            .filter((r) => r.path.toLowerCase().includes(needle))
            .slice(0, 20);
          const tools = index.tools.filter((t) => t.name.includes(needle));
          const pages = SECTIONS.flatMap((s) => s.pages).filter((p) =>
            `${p.title} ${p.summary} ${p.body}`.toLowerCase().includes(needle),
          );
          const total =
            symbols.length +
            files.length +
            tables.length +
            routes.length +
            tools.length +
            pages.length;
          const group = (title: string, items: ReactNode[]) =>
            items.length > 0 && (
              <section className="mb-8">
                <h2 className="mb-3 text-[20px] font-bold">
                  {title} · {items.length}
                </h2>
                <ul className="flex flex-col gap-1.5">{items}</ul>
              </section>
            );
          return (
            <>
              {total === 0 && (
                <p className="text-muted-foreground">
                  Nothing matches. Try a function name, a table or a path.
                </p>
              )}
              {group(
                "Pages",
                pages.map((p) => (
                  <li key={`${p.section}/${p.slug}`}>
                    <Link
                      to={`/${p.section}/${p.slug}`}
                      className="font-semibold hover:text-primary"
                    >
                      {p.title}
                    </Link>
                    <span className="ml-2 text-[13px] text-muted-foreground">{p.summary}</span>
                  </li>
                )),
              )}
              {group(
                "Functions, types and constants",
                symbols.map(({ s }) => (
                  <li key={s.id}>
                    <SymbolLink index={index} id={s.id} />
                  </li>
                )),
              )}
              {group(
                "Tables",
                tables.map((t) => (
                  <li key={t.name}>
                    <Link to={tableHref(t.name)} className="font-mono hover:text-primary">
                      {t.name}
                    </Link>
                  </li>
                )),
              )}
              {group(
                "Endpoints",
                routes.map((r) => (
                  <li key={`${r.method} ${r.path}`} className="font-mono text-[14px]">
                    <Link to={fileHref(r.file, r.line)} className="hover:text-primary">
                      {r.method} {r.path}
                    </Link>
                  </li>
                )),
              )}
              {group(
                "Tools",
                tools.map((t) => (
                  <li key={t.name}>
                    <Link
                      to="/tools"
                      hash={`tool-${t.name}`}
                      className="font-mono hover:text-primary"
                    >
                      {t.name}
                    </Link>
                  </li>
                )),
              )}
              {group(
                "Files",
                files.map((f) => (
                  <li key={f}>
                    <Link to={fileHref(f)} className="font-mono text-[14px] hover:text-primary">
                      {f}
                    </Link>
                  </li>
                )),
              )}
            </>
          );
        }}
      </WithIndex>
    </Layout>
  );
}
