import { Link, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { CodeView } from "@/components/code-view";
import { Layout, PageTitle } from "@/components/layout";
import { MarkdownView } from "@/components/markdown-view";
import {
  CallsPanel,
  EndpointList,
  KindTag,
  Loading,
  Missing,
  SymbolLink,
} from "@/components/panels";
import { topOf, useIndex, useSource, type Index } from "@/lib/data";
import type { PackageInfo, SymbolInfo } from "@/lib/index-types";
import { fileHref, packageHref, repoFile, symbolHref, tableHref } from "@/lib/links";
import { parseMarkdown } from "@/lib/markdown";
import { PAGES_BY_REF } from "@/lib/pages";

// The code explorer (ADR-0051): every package, file and symbol, from the index.

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** How much the rest of the repository relies on a symbol: callers from other files. */
function reach(index: Index, s: SymbolInfo): number {
  const ids = [s.id, ...s.members];
  const callers = new Set<string>();
  for (const id of ids) {
    for (const e of index.callsTo.get(id) ?? []) {
      const file = index.symbols[e.from]?.file ?? e.from;
      if (file !== s.file) callers.add(e.from);
    }
  }
  return callers.size;
}

function Explained({ refs }: { refs: readonly string[] }) {
  const pages = [...new Set(refs.flatMap((r) => PAGES_BY_REF.get(r) ?? []))];
  if (pages.length === 0) return null;
  return (
    <p className="my-4 text-[14.5px] text-muted-foreground">
      Explained in:{" "}
      {pages.map((p, i) => (
        <span key={`${p.section}/${p.slug}`}>
          {i > 0 && ", "}
          <Link
            to={`/${p.section}/${p.slug}`}
            className="text-foreground underline decoration-primary/60 underline-offset-[3px]"
          >
            {p.title}
          </Link>
        </span>
      ))}
    </p>
  );
}

function PackageCard({ pkg }: { pkg: PackageInfo }) {
  return (
    <Link
      to={packageHref(pkg.key)}
      className="flex flex-col gap-1.5 rounded-[18px] border border-border bg-card p-4 hover:border-primary"
    >
      <span className="font-mono text-[15px] font-semibold">{pkg.dir}</span>
      <span className="text-[14px] text-muted-foreground">{pkg.description || "—"}</span>
      <span className="mt-auto pt-1 text-[12.5px] text-muted-foreground">
        {pkg.files.length} files · used by {pkg.dependents.length}
      </span>
    </Link>
  );
}

export function Packages() {
  const { data: index, error } = useIndex();
  return (
    <Layout wide>
      <PageTitle
        eyebrow="Reference"
        title="Code explorer"
        lede="Every app and package in the repository. Apps are what gets deployed; packages are libraries they share. A package only imports the ones listed under it, and the lint rules enforce those boundaries."
      />
      {error && <p className="text-destructive">{error.message}</p>}
      {!index && !error && <Loading />}
      {index &&
        (["app", "package", "evals"] as const).map((kind) => (
          <section key={kind} className="mb-10">
            <h2 className="mb-4 text-[24px] font-bold">
              {kind === "app" ? "Apps" : kind === "package" ? "Packages" : "Evals"}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {index.packages
                .filter((p) => p.kind === kind)
                .map((p) => (
                  <PackageCard key={p.key} pkg={p} />
                ))}
            </div>
          </section>
        ))}
    </Layout>
  );
}

export function PackagePage() {
  const { pkg: key } = useParams({ strict: false }) as { pkg: string };
  const { data: index, error } = useIndex();
  if (error) return <Missing>{error.message}</Missing>;
  if (!index)
    return (
      <Layout>
        <Loading />
      </Layout>
    );
  const pkg = index.packageByKey.get(key);
  if (!pkg) return <Missing>No package called “{key}”.</Missing>;
  const inPkg = (file: string) => file.startsWith(`${pkg.dir}/`);
  const top = Object.values(index.symbols)
    .filter((s) => s.pkg === key && !s.parent && s.exported)
    .map((s) => ({ s, n: reach(index, s) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
  const routes = index.routes.filter((r) => inPkg(r.file));
  const tables = index.tables.filter((t) => inPkg(t.file));
  const jobs = index.jobs.filter((j) => inPkg(j.file));
  const tools = index.tools.filter((t) => inPkg(t.file));
  // Files by folder, so the package's shape shows.
  const folders = new Map<string, string[]>();
  for (const f of pkg.files) {
    const folder =
      f
        .slice(pkg.dir.length + 1)
        .split("/")
        .slice(0, -1)
        .join("/") || ".";
    (folders.get(folder) ?? folders.set(folder, []).get(folder)!).push(f);
  }
  return (
    <Layout wide>
      <div className="max-w-[1040px]">
        <PageTitle
          eyebrow={`${pkg.kind === "app" ? "App" : pkg.kind === "evals" ? "Evals" : "Package"} · ${pkg.name}`}
          title={<span className="font-mono">{pkg.dir}</span>}
          lede={pkg.description}
        />
        <Explained refs={pkg.files} />
        <div className="mb-10 grid gap-3 md:grid-cols-2">
          <div className="rounded-[16px] bg-card p-4">
            <h2 className="mb-2 text-[15px] font-bold">Depends on</h2>
            <div className="flex flex-wrap gap-2">
              {pkg.dependsOn.length === 0 && (
                <span className="text-muted-foreground">No other package.</span>
              )}
              {pkg.dependsOn.map((d) => (
                <Link
                  key={d}
                  to={packageHref(d)}
                  className="rounded-full bg-popover px-3 py-0.5 font-mono text-[13px] hover:text-primary"
                >
                  {d}
                </Link>
              ))}
            </div>
          </div>
          <div className="rounded-[16px] bg-card p-4">
            <h2 className="mb-2 text-[15px] font-bold">Used by</h2>
            <div className="flex flex-wrap gap-2">
              {pkg.dependents.length === 0 && (
                <span className="text-muted-foreground">Nothing depends on it.</span>
              )}
              {pkg.dependents.map((d) => (
                <Link
                  key={d}
                  to={packageHref(d)}
                  className="rounded-full bg-popover px-3 py-0.5 font-mono text-[13px] hover:text-primary"
                >
                  {d}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {top.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-1 text-[24px] font-bold">Most used from outside</h2>
            <p className="mb-4 text-[14.5px] text-muted-foreground">
              Its exports with the most callers in other files: a good place to start reading.
            </p>
            <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
              {top.map(({ s, n }) => (
                <li key={s.id} className="flex flex-col gap-1 px-4 py-2.5">
                  <span className="flex items-baseline gap-2">
                    <Link
                      to={symbolHref(s.id)}
                      className="font-mono text-[14px] font-semibold hover:text-primary"
                    >
                      {s.name}
                    </Link>
                    <KindTag kind={s.kind} />
                    <span className="ml-auto text-[12.5px] text-muted-foreground">{n} callers</span>
                  </span>
                  {s.doc && (
                    <span className="text-[13.5px] text-muted-foreground">{firstLine(s.doc)}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {routes.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-1 text-[24px] font-bold">Endpoints defined here</h2>
            <EndpointList index={index} routes={routes} />
          </section>
        )}
        {tables.length > 0 && (
          <section className="mb-10">
            <h2 className="mb-3 text-[24px] font-bold">Tables defined here</h2>
            <div className="flex flex-wrap gap-2">
              {tables.map((t) => (
                <Link
                  key={t.name}
                  to={tableHref(t.name)}
                  className="rounded-full bg-card px-3 py-1 font-mono text-[13px] hover:text-primary"
                >
                  {t.name}
                </Link>
              ))}
            </div>
          </section>
        )}
        {(jobs.length > 0 || tools.length > 0) && (
          <section className="mb-10">
            <h2 className="mb-3 text-[24px] font-bold">
              {jobs.length ? "Jobs" : "Tools"} defined here
            </h2>
            <div className="flex flex-wrap gap-2">
              {jobs.map((j) => (
                <Link
                  key={j.id}
                  to="/jobs"
                  className="rounded-full bg-card px-3 py-1 font-mono text-[13px] hover:text-primary"
                >
                  {j.id}
                </Link>
              ))}
              {tools.map((t) => (
                <Link
                  key={t.name}
                  to="/tools"
                  hash={`tool-${t.name}`}
                  className="rounded-full bg-card px-3 py-1 font-mono text-[13px] hover:text-primary"
                >
                  {t.name}
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="mb-10">
          <h2 className="mb-4 text-[24px] font-bold">Files</h2>
          {[...folders].map(([folder, list]) => (
            <div key={folder} className="mb-5">
              <h3 className="mb-2 font-mono text-[13px] text-muted-foreground">
                {folder === "."
                  ? pkg.kind === "evals"
                    ? pkg.dir
                    : `${pkg.dir}/src`
                  : `${folder}/`}
              </h3>
              <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
                {list.map((f) => {
                  const info = index.files[f];
                  return (
                    <li
                      key={f}
                      className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4"
                    >
                      <Link
                        to={fileHref(f)}
                        className="shrink-0 font-mono text-[13.5px] font-semibold hover:text-primary"
                      >
                        {f.split("/").pop()}
                      </Link>
                      <span className="text-[13.5px] text-muted-foreground">
                        {info?.header
                          ? firstLine(info.header)
                          : `${info?.symbols.length ?? 0} declarations`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {pkg.tests.length > 0 && (
            <p className="text-[13.5px] text-muted-foreground">
              Tests beside the code: {pkg.tests.map((t) => t.split("/").pop()).join(", ")}.
            </p>
          )}
        </section>
      </div>
    </Layout>
  );
}

export function FilePage() {
  const { path } = useSearch({ strict: false }) as { path?: string };
  const hash = useRouterState({ select: (s) => s.location.hash });
  const { data: index, error } = useIndex();
  const file = index && path ? index.files[path] : undefined;
  const { data: source } = useSource(file?.pkg ?? null);
  const header = useMemo(() => parseMarkdown(file?.header ?? ""), [file?.header]);
  if (error) return <Missing>{error.message}</Missing>;
  if (!index)
    return (
      <Layout>
        <Loading />
      </Layout>
    );
  if (!file || !path) return <Missing>No file “{path}” in the index.</Missing>;
  const mark = /^L(\d+)$/.exec(hash)?.[1];
  return (
    <Layout wide>
      <div className="max-w-[1100px]">
        <PageTitle
          eyebrow={`File · ${index.packageByKey.get(file.pkg)?.dir ?? file.pkg}`}
          title={<span className="font-mono text-[clamp(22px,2.6vw,32px)] break-all">{path}</span>}
        />
        {file.header && (
          <div className="mb-4 rounded-[16px] bg-card px-5 py-1">
            <MarkdownView blocks={header} index={index} />
          </div>
        )}
        <Explained refs={[path, ...file.symbols]} />
        <div className="mb-6 grid gap-3 md:grid-cols-2">
          <FileList
            index={index}
            title="Imports"
            files={file.imports}
            empty="Nothing else in the repository."
          />
          <FileList
            index={index}
            title="Imported by"
            files={file.importedBy}
            empty="No other file."
          />
        </div>
        {file.symbols.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 text-[22px] font-bold">Declared here</h2>
            <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
              {file.symbols.map((id) => {
                const s = index.symbols[id]!;
                return (
                  <li key={id} className="flex flex-col gap-0.5 px-4 py-2.5">
                    <span className="flex items-baseline gap-2">
                      <Link
                        to={symbolHref(id)}
                        className="font-mono text-[14px] font-semibold hover:text-primary"
                      >
                        {s.name}
                      </Link>
                      <KindTag kind={s.kind} />
                      {!s.exported && (
                        <span className="text-[12px] text-muted-foreground">
                          private to the file
                        </span>
                      )}
                      <a
                        href={`#L${s.line}`}
                        className="ml-auto font-mono text-[12px] text-muted-foreground hover:text-foreground"
                      >
                        L{s.line}
                      </a>
                    </span>
                    {s.doc && (
                      <span className="text-[13.5px] text-muted-foreground">
                        {firstLine(s.doc)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <h2 className="mb-1 text-[22px] font-bold">Source</h2>
        {!source ? (
          <Loading what="the source" />
        ) : (
          <CodeView
            index={index}
            path={path}
            source={source[path] ?? ""}
            anchors
            mark={mark ? Number(mark) : null}
          />
        )}
      </div>
    </Layout>
  );
}

function FileList(props: { index: Index; title: string; files: readonly string[]; empty: string }) {
  return (
    <div className="rounded-[16px] bg-card p-4">
      <h2 className="mb-2 text-[15px] font-bold">
        {props.title} · {props.files.length}
      </h2>
      {props.files.length === 0 && (
        <p className="text-[14px] text-muted-foreground">{props.empty}</p>
      )}
      <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {props.files.map((f) => (
          <li key={f}>
            <Link to={fileHref(f)} className="font-mono text-[13px] break-all hover:text-primary">
              {f}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SymbolPage() {
  const { id } = useSearch({ strict: false }) as { id?: string };
  const { data: index, error } = useIndex();
  const s = index && id ? index.symbols[id] : undefined;
  const { data: source } = useSource(s?.pkg ?? null);
  const doc = useMemo(() => parseMarkdown(s?.doc ?? ""), [s?.doc]);
  if (error) return <Missing>{error.message}</Missing>;
  if (!index)
    return (
      <Layout>
        <Loading />
      </Layout>
    );
  if (!s || !id) return <Missing>No symbol “{id}” in the index.</Missing>;
  const owner = s.parent ? topOf(index, s.id) : undefined;
  return (
    <Layout wide>
      <div className="max-w-[1100px]">
        <PageTitle
          eyebrow={`${s.kind} · ${index.packageByKey.get(s.pkg)?.dir ?? s.pkg}`}
          title={<span className="font-mono text-[clamp(24px,3vw,38px)] break-all">{s.name}</span>}
        />
        <p className="-mt-4 mb-6 flex flex-wrap gap-x-4 gap-y-1 text-[14px] text-muted-foreground">
          <Link to={fileHref(s.file, s.line)} className="font-mono hover:text-foreground">
            {s.file}:{s.line}
          </Link>
          {owner && (
            <span>
              part of <SymbolLink index={index} id={owner.id} />
            </span>
          )}
          <span>{s.exported || s.parent ? "exported" : "private to its file"}</span>
          <a
            href={repoFile(s.file, s.line)}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-foreground"
          >
            GitHub ↗
          </a>
        </p>
        <pre className="mb-6 overflow-x-auto rounded-[14px] bg-card px-4 py-3 font-mono text-[13.5px] whitespace-pre-wrap text-foreground">
          {s.signature}
        </pre>
        {s.doc ? (
          <div className="mb-4">
            <MarkdownView blocks={doc} index={index} />
          </div>
        ) : (
          <p className="mb-4 text-muted-foreground">
            No doc comment; the code below says what it does.
          </p>
        )}
        <Explained refs={[s.id, ...(owner ? [owner.id] : [])]} />
        {s.members.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 text-[22px] font-bold">Members</h2>
            <ul className="flex flex-col divide-y divide-border rounded-[16px] border border-border bg-card">
              {s.members.map((m) => {
                const member = index.symbols[m]!;
                const callers = index.callsTo.get(m)?.length ?? 0;
                return (
                  <li key={m} className="flex flex-col gap-0.5 px-4 py-2.5">
                    <span className="flex items-baseline gap-2">
                      <Link
                        to={symbolHref(m)}
                        className="font-mono text-[14px] font-semibold hover:text-primary"
                      >
                        {member.name.split(".").pop()}
                      </Link>
                      <KindTag kind={member.kind} />
                      {callers > 0 && (
                        <span className="ml-auto text-[12.5px] text-muted-foreground">
                          {callers} callers
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-[12.5px] break-all text-muted-foreground">
                      {member.signature}
                    </span>
                    {member.doc && <span className="text-[13.5px]">{firstLine(member.doc)}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <h2 className="mt-8 text-[22px] font-bold">Calls</h2>
        <CallsPanel index={index} id={s.id} />
        <h2 className="mt-8 text-[22px] font-bold">Source</h2>
        {!source ? (
          <Loading what="the source" />
        ) : (
          <CodeView
            index={index}
            path={s.file}
            source={source[s.file] ?? ""}
            start={s.line}
            end={s.end}
          />
        )}
      </div>
    </Layout>
  );
}
