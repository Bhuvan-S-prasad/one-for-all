import { useEffect, useState } from "react";
import type { CallEdge, CodeIndex, SourceChunk, SymbolInfo } from "./index-types";

// The code index (ADR-0051), loaded once on first use, and each package's
// source loaded only when a page shows code from it. Both are made by
// scripts/index-repo.ts before the build; `import.meta.glob` keeps
// typechecking independent of them.

const indexFile = import.meta.glob<CodeIndex>("../generated/index.json", { import: "default" });
const sourceFiles = import.meta.glob<SourceChunk>("../generated/source/*.json", {
  import: "default",
});

/** The index with lookups built once. */
export interface Index extends CodeIndex {
  readonly callsFrom: ReadonlyMap<string, readonly CallEdge[]>;
  readonly callsTo: ReadonlyMap<string, readonly CallEdge[]>;
  readonly packageByKey: ReadonlyMap<string, CodeIndex["packages"][number]>;
  readonly tableByName: ReadonlyMap<string, CodeIndex["tables"][number]>;
}

function withLookups(raw: CodeIndex): Index {
  const from = new Map<string, CallEdge[]>();
  const to = new Map<string, CallEdge[]>();
  for (const e of raw.calls) {
    (from.get(e.from) ?? from.set(e.from, []).get(e.from)!).push(e);
    (to.get(e.to) ?? to.set(e.to, []).get(e.to)!).push(e);
  }
  return {
    ...raw,
    callsFrom: from,
    callsTo: to,
    packageByKey: new Map(raw.packages.map((p) => [p.key, p])),
    tableByName: new Map(raw.tables.map((t) => [t.name, t])),
  };
}

let indexPromise: Promise<Index> | null = null;
let indexValue: Index | null = null;

export function loadIndex(): Promise<Index> {
  const load = Object.values(indexFile)[0];
  if (!load) {
    return Promise.reject(
      new Error("No code index. Run `pnpm --filter @ofa/learn index` before starting the app."),
    );
  }
  indexPromise ??= load().then((raw) => (indexValue = withLookups(raw)));
  return indexPromise;
}

const sourceCache = new Map<string, Promise<SourceChunk>>();
const sourceValues = new Map<string, SourceChunk>();

export function loadSource(pkg: string): Promise<SourceChunk> {
  const load = sourceFiles[`../generated/source/${pkg}.json`];
  if (!load) return Promise.resolve({});
  let p = sourceCache.get(pkg);
  if (!p) {
    p = load().then((chunk) => {
      sourceValues.set(pkg, chunk);
      return chunk;
    });
    sourceCache.set(pkg, p);
  }
  return p;
}

type State<T> = { data: T; error: null } | { data: null; error: Error | null };

/**
 * Read a cached value during render; load it once if it isn't there yet, and
 * render again when it arrives.
 */
function useLoaded<T>(key: string | null, peek: () => T | null, load: () => Promise<T>): State<T> {
  const [, setLoaded] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const data = key ? peek() : null;
  useEffect(() => {
    if (!key || peek()) return;
    let live = true;
    load().then(
      () => live && setLoaded((n) => n + 1),
      (e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      live = false;
    };
    // `peek` and `load` follow `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return data ? { data, error: null } : { data: null, error };
}

export function useIndex(): State<Index> {
  return useLoaded("index", () => indexValue, loadIndex);
}

export function useSource(pkg: string | null): State<SourceChunk> {
  return useLoaded(
    pkg,
    () => (pkg ? (sourceValues.get(pkg) ?? null) : null),
    () => loadSource(pkg!),
  );
}

/** The top-level symbol a member belongs to (itself if it is one). */
export function topOf(index: Index, id: string): SymbolInfo | undefined {
  let s = index.symbols[id];
  while (s?.parent) s = index.symbols[s.parent];
  return s;
}

/** A package's display label: `@ofa/harness` → `harness`, with its folder. */
export function packageLabel(index: Index, key: string): string {
  return index.packageByKey.get(key)?.dir ?? key;
}
