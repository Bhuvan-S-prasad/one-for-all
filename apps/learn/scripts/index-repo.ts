// The code index (ADR-0051): read the repository's TypeScript with the
// compiler, write what apps/learn shows to src/generated, and check every
// reference in the written pages. Run before Vite (`pnpm --filter @ofa/learn
// index`); a reference that doesn't resolve fails it.
//
// It reads source files only: `.ts` and `.tsx` under apps/*/src,
// packages/*/src and evals, package.json files, and the written pages.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type {
  CallEdge,
  CodeIndex,
  ColumnInfo,
  EnumInfo,
  EventInfo,
  FileInfo,
  JobInfo,
  PackageInfo,
  PackageKind,
  RouteInfo,
  SymbolInfo,
  SymbolKind,
  TableInfo,
  ToolInfo,
} from "../src/lib/index-types";
import { collectRefs, narrow, parsePage, splitApiRef, splitCodeRef } from "../src/lib/refs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUT = fileURLToPath(new URL("../src/generated", import.meta.url));
const CONTENT = fileURLToPath(new URL("../content", import.meta.url));
const started = Date.now();

const rel = (abs: string) => relative(ROOT, abs).split("\\").join("/");
const abs = (path: string) => join(ROOT, path);

// ── Packages and files ───────────────────────────────────────────────────────

/** Folders never read: dependencies, output, generated code, this app. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "generated", ".turbo", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

const isTest = (path: string) => /\.(test|spec)\.tsx?$/.test(path);
const isGenerated = (path: string) => /\.gen\.ts$/.test(path);

interface PackageDraft {
  key: string;
  name: string;
  dir: string;
  kind: PackageKind;
  description: string;
  deps: string[];
  files: string[];
  tests: string[];
}

function readPackage(dir: string, kind: PackageKind): PackageDraft | null {
  const manifest = join(ROOT, dir, "package.json");
  if (!existsSync(manifest)) return null;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
    name: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const sourceDir = kind === "evals" ? join(ROOT, dir) : join(ROOT, dir, "src");
  const all = walk(sourceDir).map(rel).sort();
  return {
    key: pkg.name.replace(/^@ofa\//, ""),
    name: pkg.name,
    dir,
    kind,
    description: pkg.description ?? "",
    deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
      d.startsWith("@ofa/"),
    ),
    files: all.filter((f) => !isTest(f) && !isGenerated(f)),
    tests: all.filter(isTest),
  };
}

const drafts: PackageDraft[] = [];
for (const [folder, kind] of [
  ["apps", "app"],
  ["packages", "package"],
] as const) {
  for (const entry of readdirSync(join(ROOT, folder), { withFileTypes: true })) {
    // This app explains the others; it isn't part of what it explains.
    if (!entry.isDirectory() || (folder === "apps" && entry.name === "learn")) continue;
    const draft = readPackage(`${folder}/${entry.name}`, kind);
    if (draft) drafts.push(draft);
  }
}
const evalsDraft = readPackage("evals", "evals");
if (evalsDraft) drafts.push(evalsDraft);

const byName = new Map(drafts.map((d) => [d.name, d]));
const packages: PackageInfo[] = drafts.map((d) => ({
  key: d.key,
  name: d.name,
  dir: d.dir,
  kind: d.kind,
  description: d.description,
  dependsOn: d.deps.flatMap((dep) => byName.get(dep)?.key ?? []).sort(),
  dependents: drafts
    .filter((other) => other.deps.includes(d.name))
    .map((other) => other.key)
    .sort(),
  files: d.files,
  tests: d.tests,
}));
const pkgOf = new Map<string, string>();
for (const d of drafts) for (const f of d.files) pkgOf.set(f, d.key);

// ── The program ──────────────────────────────────────────────────────────────

const rootNames = [...pkgOf.keys()].map(abs);
const program = ts.createProgram(rootNames, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
});
const checker = program.getTypeChecker();
const sources = new Map<string, ts.SourceFile>();
for (const path of pkgOf.keys()) {
  const sf = program.getSourceFile(abs(path));
  if (sf) sources.set(path, sf);
}

// ── Comments ─────────────────────────────────────────────────────────────────

function cleanBlock(text: string): string {
  return text
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();
}

/** The doc comment of a declaration: its JSDoc block, else the line comments right above it. */
function docOf(node: ts.Node, sf: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const blocks = ranges.filter((r) => sf.text.slice(r.pos, r.pos + 3) === "/**");
  const last = blocks.at(-1);
  if (last) return cleanBlock(sf.text.slice(last.pos, last.end));
  // `//` lines touching the declaration.
  const lines: string[] = [];
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const r = ranges[i]!;
    const text = sf.text.slice(r.pos, r.end);
    if (!text.startsWith("//")) break;
    const gap = sf.text.slice(
      r.end,
      i === ranges.length - 1 ? node.getStart(sf) : ranges[i + 1]!.pos,
    );
    if ((gap.match(/\n/g) ?? []).length > 1) break;
    lines.unshift(text.replace(/^\/\/ ?/, ""));
  }
  return lines.join("\n").trim();
}

/** What a file is for: the first `//` block before its first declaration. */
function headerOf(sf: ts.SourceFile): string {
  const first = sf.statements.find((s) => !ts.isImportDeclaration(s));
  const pos = first ? first.getFullStart() : sf.text.length;
  const ranges = [
    ...(ts.getLeadingCommentRanges(sf.text, 0) ?? []),
    ...(first ? (ts.getLeadingCommentRanges(sf.text, pos) ?? []) : []),
  ];
  const blocks: string[][] = [];
  let current: string[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    const text = sf.text.slice(r.pos, r.end);
    if (!text.startsWith("//")) {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    const gap = lastEnd < 0 ? "" : sf.text.slice(lastEnd, r.pos);
    if ((gap.match(/\n/g) ?? []).length > 1 && current.length) {
      blocks.push(current);
      current = [];
    }
    current.push(text.replace(/^\/\/ ?/, ""));
    lastEnd = r.end;
  }
  if (current.length) blocks.push(current);
  return (blocks[0] ?? []).join("\n").trim();
}

// ── Symbols ──────────────────────────────────────────────────────────────────

const symbols: Record<string, SymbolInfo> = {};
const declToId = new Map<ts.Node, string>();
const fileSymbols = new Map<string, string[]>();

const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const oneLine = (text: string, max = 500) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const isExported = (node: ts.Node) =>
  !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);

/** The declaration up to its body. */
function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const start = node.getStart(sf);
  let body: ts.Node | undefined;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) body = node.body;
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) body = init.body;
  }
  if (ts.isPropertyAssignment(node)) {
    const init = node.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) body = init.body;
  }
  if (body && !ts.isExpression(body)) return oneLine(sf.text.slice(start, body.getStart(sf)));
  if (body) return oneLine(sf.text.slice(start, body.getStart(sf)));
  const text = sf.text.slice(start, node.getEnd());
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return oneLine(text.slice(0, text.indexOf("{") + 1) + " … }");
  }
  return oneLine(text, 300);
}

function add(
  node: ts.Node,
  sf: ts.SourceFile,
  path: string,
  name: string,
  kind: SymbolKind,
  parent: string | null,
  docNode: ts.Node = node,
  exported = false,
): string {
  const id = parent ? `${parent}.${name}` : `${path}#${name}`;
  if (symbols[id]) return id;
  symbols[id] = {
    id,
    name: parent ? `${symbols[parent]!.name}.${name}` : name,
    kind,
    file: path,
    pkg: pkgOf.get(path) ?? "",
    line: lineOf(sf, node.getStart(sf)),
    end: lineOf(sf, node.getEnd()),
    exported,
    signature: signatureOf(node, sf),
    doc: docOf(docNode, sf),
    parent,
    members: [],
  };
  declToId.set(node, id);
  if (parent) (symbols[parent]!.members as string[]).push(id);
  else fileSymbols.get(path)!.push(id);
  return id;
}

const propName = (name: ts.PropertyName | ts.BindingName | undefined) =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name))
    ? name.text
    : null;

/** Function declarations inside a function's body: `runAgent` → `runAgent.finish`. */
function addNested(body: ts.Node | undefined, sf: ts.SourceFile, path: string, parent: string) {
  if (!body) return;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) {
      add(n, sf, path, n.name.text, "function", parent);
      return;
    }
    if (ts.isClassDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      // Not one level down: a callback's own helpers stay with it.
      if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
}

/** An object literal's members: `INNGEST_EVENTS.messageReceived`, `PLATFORM_RULES.render`. */
function addObjectMembers(obj: ts.Expression, sf: ts.SourceFile, path: string, parent: string) {
  let e: ts.Expression = obj;
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  if (!ts.isObjectLiteralExpression(e)) return;
  for (const p of e.properties) {
    const name = propName(p.name);
    if (!name) continue;
    if (ts.isMethodDeclaration(p)) add(p, sf, path, name, "method", parent);
    else if (ts.isPropertyAssignment(p)) {
      const fn = ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer);
      add(p, sf, path, name, fn ? "method" : "property", parent);
    } else if (ts.isShorthandPropertyAssignment(p)) add(p, sf, path, name, "property", parent);
  }
}

for (const [path, sf] of sources) {
  fileSymbols.set(path, []);
  const tsx = path.endsWith(".tsx");
  for (const st of sf.statements) {
    const exported = isExported(st);
    if (ts.isFunctionDeclaration(st) && st.name) {
      const kind = tsx && /^[A-Z]/.test(st.name.text) ? "component" : "function";
      const id = add(st, sf, path, st.name.text, kind, null, st, exported);
      addNested(st.body, sf, path, id);
    } else if (ts.isClassDeclaration(st) && st.name) {
      const id = add(st, sf, path, st.name.text, "class", null, st, exported);
      for (const m of st.members) {
        const name = propName(m.name);
        if (!name) continue;
        add(m, sf, path, name, ts.isMethodDeclaration(m) ? "method" : "property", id);
      }
    } else if (ts.isInterfaceDeclaration(st)) {
      const id = add(st, sf, path, st.name.text, "interface", null, st, exported);
      for (const m of st.members) {
        const name = propName(m.name);
        if (!name) continue;
        add(m, sf, path, name, ts.isMethodSignature(m) ? "method" : "property", id);
      }
    } else if (ts.isTypeAliasDeclaration(st)) {
      const id = add(st, sf, path, st.name.text, "type", null, st, exported);
      if (ts.isTypeLiteralNode(st.type)) {
        for (const m of st.type.members) {
          const name = propName(m.name);
          if (name) add(m, sf, path, name, ts.isMethodSignature(m) ? "method" : "property", id);
        }
      }
    } else if (ts.isEnumDeclaration(st)) {
      add(st, sf, path, st.name.text, "enum", null, st, exported);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const fn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const kind: SymbolKind = fn
          ? tsx && /^[A-Z]/.test(d.name.text)
            ? "component"
            : "function"
          : "const";
        const id = add(d, sf, path, d.name.text, kind, null, st, exported);
        if (fn) addNested((init as ts.ArrowFunction).body, sf, path, id);
        else if (init) addObjectMembers(init, sf, path, id);
      }
    }
  }
}

// ── Calls ────────────────────────────────────────────────────────────────────

/** The indexed declaration a node belongs to, walking up; null outside the index. */
function ownerOf(node: ts.Node | undefined): string | null {
  for (let n = node; n; n = n.parent) {
    const id = declToId.get(n);
    if (id) return id;
  }
  return null;
}

function targetOf(expr: ts.Node): string | null {
  const nameNode = ts.isPropertyAccessExpression(expr)
    ? expr.name
    : ts.isElementAccessExpression(expr)
      ? expr.argumentExpression
      : expr;
  let sym = checker.getSymbolAtLocation(nameNode);
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      return null;
    }
  }
  for (const decl of sym.declarations ?? []) {
    const path = rel(decl.getSourceFile().fileName);
    if (!pkgOf.has(path)) continue;
    const id = ownerOf(decl);
    if (id) return id;
  }
  return null;
}

const edges = new Map<string, CallEdge>();
function addEdge(from: string, to: string, kind: CallEdge["kind"], line: number, name: string) {
  // Within one function (a nested helper and the closure around it) isn't a call between symbols.
  if (from === to || to.startsWith(`${from}.`) || from.startsWith(`${to}.`)) return;
  const key = `${from}→${to}`;
  const seen = edges.get(key);
  if (seen) edges.set(key, { ...seen, count: seen.count + 1 });
  else edges.set(key, { from, to, kind, line, name, count: 1 });
}

/** Where a call is written: its method name in a chain (`.post(` on line 168), not where the chain starts. */
const callLine = (sf: ts.SourceFile, expr: ts.Node) =>
  lineOf(sf, (ts.isPropertyAccessExpression(expr) ? expr.name : expr).getStart(sf));

const nameAt = (expr: ts.Node) =>
  ts.isPropertyAccessExpression(expr) ? expr.name.text : expr.getText().slice(0, 60);

for (const [path, sf] of sources) {
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const to = targetOf(n.expression);
      if (to)
        addEdge(ownerOf(n) ?? path, to, "call", callLine(sf, n.expression), nameAt(n.expression));
    } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const to = targetOf(n.tagName);
      if (to)
        addEdge(ownerOf(n) ?? path, to, "render", lineOf(sf, n.getStart(sf)), n.tagName.getText());
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ── Files and imports ────────────────────────────────────────────────────────

const files: Record<string, FileInfo> = {};
const importedBy = new Map<string, Set<string>>();
for (const [path, sf] of sources) {
  const imports = new Set<string>();
  for (const st of sf.statements) {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier)
      continue;
    const spec = (st.moduleSpecifier as ts.StringLiteral).text;
    const resolved = ts.resolveModuleName(spec, sf.fileName, program.getCompilerOptions(), ts.sys)
      .resolvedModule?.resolvedFileName;
    if (!resolved) continue;
    const target = rel(ts.sys.realpath ? ts.sys.realpath(resolved) : resolved);
    if (pkgOf.has(target) && target !== path) imports.add(target);
  }
  for (const target of imports) {
    if (!importedBy.has(target)) importedBy.set(target, new Set());
    importedBy.get(target)!.add(path);
  }
  files[path] = {
    path,
    pkg: pkgOf.get(path)!,
    header: headerOf(sf),
    lines: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1,
    symbols: fileSymbols.get(path) ?? [],
    imports: [...imports].sort(),
    importedBy: [],
  };
}
for (const [path, by] of importedBy) {
  if (files[path]) files[path] = { ...files[path], importedBy: [...by].sort() };
}

// ── Domain facts: tables, endpoints, events, jobs, tools ─────────────────────

const stringOf = (e: ts.Expression | undefined): string | null => {
  if (!e) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  // A constant: its literal type, or its initializer.
  const type = checker.getTypeAtLocation(e);
  if (type.isStringLiteral()) return type.value;
  const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e);
  const decl = sym?.valueDeclaration;
  if (
    decl &&
    (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) &&
    decl.initializer
  ) {
    const init = decl.initializer;
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
  }
  return null;
};

const objectProp = (obj: ts.ObjectLiteralExpression, key: string) => {
  const p = obj.properties.find((x) => propName(x.name) === key);
  return p && ts.isPropertyAssignment(p) ? p.initializer : undefined;
};

const calleeName = (call: ts.CallExpression) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : "";

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Tables from the Drizzle schema (packages/db/src/schema). */
const tables: TableInfo[] = [];
const enums: EnumInfo[] = [];
const tableByVar = new Map<string, string>();
const tenantTables = new Set<string>();
{
  const tenant = sources.get("packages/db/src/tenant.ts");
  tenant?.forEachChild(function find(n): void {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "TENANT_TABLES" &&
      n.initializer
    ) {
      let e: ts.Expression = n.initializer;
      while (ts.isAsExpression(e)) e = e.expression;
      if (ts.isArrayLiteralExpression(e)) {
        for (const el of e.elements) if (ts.isStringLiteral(el)) tenantTables.add(el.text);
      }
    }
    ts.forEachChild(n, find);
  });

  const drafts: {
    decl: ts.VariableDeclaration;
    call: ts.CallExpression;
    sf: ts.SourceFile;
    path: string;
    statement: ts.Node;
  }[] = [];
  for (const [path, sf] of sources) {
    if (!path.startsWith("packages/db/src/schema/")) continue;
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer || !ts.isCallExpression(d.initializer))
          continue;
        const call = d.initializer;
        const callee = calleeName(call);
        if (callee === "pgTable") {
          const name = stringOf(call.arguments[0]);
          if (name) {
            tableByVar.set(d.name.text, name);
            drafts.push({ decl: d, call, sf, path, statement: st });
          }
        } else if (callee === "pgEnum") {
          const name = stringOf(call.arguments[0]);
          let values: string[] = [];
          const arg = call.arguments[1];
          if (arg && ts.isArrayLiteralExpression(arg)) {
            values = arg.elements.flatMap((el) => stringOf(el) ?? []);
          } else if (arg) {
            // A shared list from @ofa/core: its literal values.
            const type = checker.getTypeAtLocation(arg);
            const items = checker.isTupleType(type)
              ? checker.getTypeArguments(type as ts.TypeReference)
              : [];
            values = items.flatMap((t) => (t.isStringLiteral() ? [t.value] : []));
          }
          if (name) {
            enums.push({
              name,
              variable: d.name.text,
              values,
              file: path,
              line: lineOf(sf, d.getStart(sf)),
              doc: docOf(st, sf),
            });
          }
        }
      }
    }
  }

  for (const { decl, call, sf, path, statement } of drafts) {
    const name = tableByVar.get((decl.name as ts.Identifier).text)!;
    const columns: ColumnInfo[] = [];
    const shape = call.arguments[1];
    if (shape && ts.isObjectLiteralExpression(shape)) {
      for (const p of shape.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = propName(p.name);
        if (!key) continue;
        const chain: string[] = [];
        let refTable: string | null = null;
        let defaultValue: string | null = null;
        let e: ts.Expression = p.initializer;
        while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
          const method = e.expression.name.text;
          chain.push(method);
          if (method === "references") {
            const target = e.arguments[0];
            const body = target && ts.isArrowFunction(target) ? target.body : undefined;
            if (body && ts.isPropertyAccessExpression(body) && ts.isIdentifier(body.expression)) {
              refTable = body.expression.text;
            }
          }
          if (method === "default" || method === "defaultNow" || method === "defaultRandom") {
            defaultValue =
              method === "default" ? (e.arguments[0]?.getText(sf) ?? "") : `${method}()`;
          }
          e = e.expression.expression;
        }
        const base = ts.isCallExpression(e) ? e : null;
        const type = base ? calleeName(base) : e.getText(sf);
        const column = (base && stringOf(base.arguments[0])) || snake(key);
        // Helpers from columns.ts and tenancy.ts.
        const helperPk = type === "id";
        const helperTenant = type === "workspaceId";
        columns.push({
          key,
          column,
          type,
          notNull:
            chain.includes("notNull") ||
            helperPk ||
            helperTenant ||
            type === "createdAt" ||
            type === "updatedAt",
          primaryKey: chain.includes("primaryKey") || helperPk,
          unique: chain.includes("unique"),
          array: chain.includes("array"),
          defaultValue: helperPk ? "gen_random_uuid()" : defaultValue,
          references: helperTenant ? "workspace" : refTable,
          doc: docOf(p, sf),
        });
      }
    }
    const foreignKeys: TableInfo["foreignKeys"][number][] = [];
    const constraints: TableInfo["constraints"][number][] = [];
    const extras = call.arguments[2];
    const list =
      extras && ts.isArrowFunction(extras) && ts.isArrayLiteralExpression(extras.body)
        ? extras.body.elements
        : [];
    for (const el of list) {
      let c: ts.Expression = el;
      while (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression)) {
        if (
          ["foreignKey", "index", "uniqueIndex", "unique", "check", "primaryKey"].includes(
            c.expression.name.text,
          )
        )
          break;
        c = c.expression.expression;
      }
      if (!ts.isCallExpression(c)) continue;
      const kind = calleeName(c);
      const arg = c.arguments[0];
      if (kind === "foreignKey" && arg && ts.isObjectLiteralExpression(arg)) {
        const cols = objectProp(arg, "columns");
        const foreign = objectProp(arg, "foreignColumns");
        const target =
          foreign && ts.isArrayLiteralExpression(foreign) && foreign.elements[0]
            ? foreign.elements[0]
            : undefined;
        const targetVar =
          target && ts.isPropertyAccessExpression(target) ? target.expression.getText(sf) : "";
        foreignKeys.push({
          name: stringOf(objectProp(arg, "name")) ?? "",
          columns:
            cols && ts.isArrayLiteralExpression(cols)
              ? cols.elements.map((x) => {
                  const k = ts.isPropertyAccessExpression(x) ? x.name.text : x.getText(sf);
                  return columns.find((col) => col.key === k)?.column ?? k;
                })
              : [],
          // `t` is the table itself (a self reference).
          table: targetVar === "t" ? name : (tableByVar.get(targetVar) ?? targetVar),
        });
      } else if (kind) {
        constraints.push({ kind, name: stringOf(arg) ?? "" });
      }
    }
    tables.push({
      name,
      variable: (decl.name as ts.Identifier).text,
      file: path,
      line: lineOf(sf, decl.getStart(sf)),
      doc: docOf(statement, sf),
      columns: columns.map((c) => ({
        ...c,
        references: c.references ? (tableByVar.get(c.references) ?? c.references) : null,
      })),
      foreignKeys,
      constraints,
      tenant: tenantTables.has(name),
    });
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
}

/** Endpoints: Hono routers mounted in apps/api/src/app.ts. */
const routes: RouteInfo[] = [];
{
  const METHODS = ["get", "post", "put", "patch", "delete"] as const;
  const mounts = new Map<string, string>();
  const app = sources.get("apps/api/src/app.ts");
  app?.forEachChild(function find(n): void {
    if (ts.isCallExpression(n) && calleeName(n) === "route" && n.arguments.length >= 2) {
      const prefix = stringOf(n.arguments[0]);
      const router = n.arguments[1];
      if (prefix && router && ts.isCallExpression(router) && ts.isIdentifier(router.expression)) {
        mounts.set(router.expression.text, prefix);
      }
    }
    ts.forEachChild(n, find);
  });
  for (const [path, sf] of sources) {
    if (!path.startsWith("apps/api/src/") || isTest(path)) continue;
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        (METHODS as readonly string[]).includes(n.expression.name.text)
      ) {
        const sub = stringOf(n.arguments[0]);
        // A handler must follow the path: `.get("/", (c) => …)`, not `map.get("/x")`.
        if (sub?.startsWith("/") && n.arguments.length >= 2) {
          const owner = ownerOf(n) ?? path;
          let top = owner;
          while (symbols[top]?.parent) top = symbols[top]!.parent!;
          const fnName = symbols[top]?.name ?? "";
          const prefix = mounts.get(fnName);
          const full = prefix ? `${prefix}${sub === "/" ? "" : sub}` : sub;
          if (prefix || full.startsWith("/api")) {
            routes.push({
              method: n.expression.name.text.toUpperCase() as RouteInfo["method"],
              path: full,
              file: path,
              line: callLine(sf, n.expression),
              owner: top,
              doc: "",
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // Descriptions from the route list in each router's doc comment:
  //   GET   /api/threads/:id/messages   newest page first, …
  for (const [i, r] of routes.entries()) {
    const doc = symbols[r.owner]?.doc ?? "";
    for (const m of doc.matchAll(/^[ \t]*(GET|POST|PUT|PATCH|DELETE)[ \t]+(\S+)[ \t]+(.+)$/gm)) {
      if (m[1] === r.method && m[2] === r.path) routes[i] = { ...r, doc: m[3]!.trim() };
    }
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Inngest events (INNGEST_EVENTS) and the functions they start. */
const events: EventInfo[] = [];
const jobs: JobInfo[] = [];
{
  const sf = sources.get("packages/contracts/src/events.ts");
  const id = "packages/contracts/src/events.ts#INNGEST_EVENTS";
  for (const memberId of symbols[id]?.members ?? []) {
    const m = symbols[memberId]!;
    const key = m.name.split(".").pop()!;
    const value = /"([^"]+)"/.exec(m.signature)?.[1] ?? "";
    if (sf) events.push({ key, name: value, doc: m.doc, file: m.file, line: m.line });
  }
  const eventByKey = new Map(events.map((e) => [e.key, e.name]));
  for (const [path, sf] of sources) {
    if (isTest(path)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && calleeName(n) === "createFunction") {
        const opts = n.arguments[0];
        if (opts && ts.isObjectLiteralExpression(opts)) {
          const triggers: string[] = [];
          const t = objectProp(opts, "triggers");
          if (t && ts.isArrayLiteralExpression(t)) {
            for (const el of t.elements) {
              if (!ts.isObjectLiteralExpression(el)) continue;
              const ev = objectProp(el, "event");
              const cron = objectProp(el, "cron");
              if (ev) {
                const key = ts.isPropertyAccessExpression(ev) ? ev.name.text : "";
                triggers.push(eventByKey.get(key) ?? stringOf(ev) ?? ev.getText(sf));
              }
              if (cron) triggers.push(`cron ${stringOf(cron) ?? cron.getText(sf)}`);
            }
          }
          const jobId = stringOf(objectProp(opts, "id"));
          if (jobId) {
            jobs.push({
              id: jobId,
              name: stringOf(objectProp(opts, "name")) ?? jobId,
              triggers,
              file: path,
              line: callLine(sf, n.expression),
              owner: ownerOf(n) ?? path,
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

/** Built-in tools: every `defineTool({ name, description })`. */
const tools: ToolInfo[] = [];
for (const [path, sf] of sources) {
  if (!path.startsWith("packages/tools/src/") || isTest(path)) continue;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && calleeName(n) === "defineTool") {
      const opts = n.arguments[0];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        const name = stringOf(objectProp(opts, "name"));
        if (name) {
          tools.push({
            name,
            description: stringOf(objectProp(opts, "description")) ?? "",
            file: path,
            line: callLine(sf, n.expression),
            owner: ownerOf(n) ?? path,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
tools.sort((a, b) => a.name.localeCompare(b.name));

// ── Write ────────────────────────────────────────────────────────────────────

const index: CodeIndex = {
  generatedAt: new Date().toISOString(),
  packages,
  files,
  symbols,
  calls: [...edges.values()],
  tables,
  enums,
  routes,
  events,
  jobs,
  tools,
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "source"), { recursive: true });
writeFileSync(join(OUT, "index.json"), JSON.stringify(index));
for (const p of packages) {
  const chunk: Record<string, string> = {};
  for (const f of p.files) chunk[f] = sources.get(f)?.text ?? "";
  writeFileSync(join(OUT, "source", `${p.key}.json`), JSON.stringify(chunk));
}

// ── Check the written pages ──────────────────────────────────────────────────

const problems: string[] = [];
const pages = new Set<string>();
const pageFiles: { section: string; file: string; text: string }[] = [];
if (existsSync(CONTENT)) {
  for (const section of readdirSync(CONTENT, { withFileTypes: true })) {
    if (!section.isDirectory()) continue;
    for (const file of readdirSync(join(CONTENT, section.name))) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(CONTENT, section.name, file), "utf8");
      const page = parsePage(section.name, file, text);
      pages.add(`${section.name}/${page.slug}`);
      pageFiles.push({ section: section.name, file, text });
    }
  }
}
const adrs = new Set(
  readdirSync(join(ROOT, "docs/adr"))
    .map((f) => /^(\d{4})-/.exec(f)?.[1])
    .filter((x): x is string => !!x),
);
const packageKeys = new Set(packages.map((p) => p.key));
const tableNames = new Set(tables.map((t) => t.name));

for (const { section, file, text } of pageFiles) {
  const where = `content/${section}/${file}`;
  for (const r of collectRefs(text)) {
    const fail = (why: string) => problems.push(`${where}: ${r.kind} "${r.ref}" ${why}`);
    if (r.kind === "code" || r.kind === "calls") {
      const { path, symbol } = splitCodeRef(r.ref);
      const fileInfo = files[path];
      if (!fileInfo) {
        fail("names a file the index doesn't have");
        continue;
      }
      const sym = symbol ? symbols[`${path}#${symbol}`] : null;
      if (symbol && !sym) {
        fail(`names no symbol in ${path}`);
        continue;
      }
      if (r.from || r.to) {
        const text = sources.get(path)!.text;
        const span = narrow(text, sym?.line ?? 1, sym?.end ?? fileInfo.lines, r.from, r.to);
        if (!span) fail(`has a from/to anchor that isn't in the code any more`);
      }
    } else if (r.kind === "table") {
      if (!tableNames.has(r.ref)) fail("names no table");
    } else if (r.kind === "endpoints") {
      if (!routes.some((x) => x.path.startsWith(r.ref))) fail("matches no endpoint");
    } else if (r.kind === "api") {
      const { method, path } = splitApiRef(r.ref);
      if (!routes.some((x) => x.method === method && x.path === path)) fail("names no endpoint");
    } else if (r.kind === "adr") {
      if (!adrs.has(r.ref)) fail("names no decision record");
    } else if (r.kind === "page") {
      if (!pages.has(r.ref)) fail("names no page");
    } else if (r.kind === "pkg") {
      if (!packageKeys.has(r.ref)) fail("names no package");
    }
  }
}

const count = (n: number, what: string) => `${n} ${what}`;
console.warn(
  [
    `Indexed ${count(packages.length, "packages")}, ${count(Object.keys(files).length, "files")}, ${count(Object.keys(symbols).length, "symbols")}, ${count(edges.size, "call edges")},`,
    `${count(tables.length, "tables")}, ${count(routes.length, "endpoints")}, ${count(jobs.length, "jobs")}, ${count(tools.length, "tools")}; ${count(pageFiles.length, "pages")} checked in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
  ].join(" "),
);
if (problems.length > 0) {
  console.error(`\n${problems.length} reference(s) in apps/learn/content don't match the code:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// Keep the folder's purpose obvious to anyone who finds it.
writeFileSync(
  join(dirname(join(OUT, "index.json")), "README.md"),
  "Made by scripts/index-repo.ts at build time (ADR-0051). Not committed.\n",
);
