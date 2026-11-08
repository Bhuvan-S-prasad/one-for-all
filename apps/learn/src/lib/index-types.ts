// The shape of the code index (ADR-0051): what scripts/index-repo.ts writes to
// src/generated, and what every page reads. Paths are repository-relative
// with forward slashes; a symbol's ID is `path#Name` (a member `path#Parent.name`).

export type PackageKind = "app" | "package" | "evals";

export interface PackageInfo {
  /** `harness`, `api`, `evals`: the name without `@ofa/`. */
  readonly key: string;
  readonly name: string;
  readonly dir: string;
  readonly kind: PackageKind;
  readonly description: string;
  /** Workspace packages it depends on, by key. */
  readonly dependsOn: readonly string[];
  readonly dependents: readonly string[];
  /** Source files, in path order. */
  readonly files: readonly string[];
  /** Test files beside the code (not indexed for calls). */
  readonly tests: readonly string[];
}

export type SymbolKind =
  | "function"
  | "component"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum"
  | "method"
  | "property";

export interface SymbolInfo {
  readonly id: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly file: string;
  readonly pkg: string;
  /** 1-based, inclusive. */
  readonly line: number;
  readonly end: number;
  readonly exported: boolean;
  /** The declaration without its body, on one line where it fits. */
  readonly signature: string;
  /** Its doc comment (or the line comments right above it), as written. */
  readonly doc: string;
  readonly parent: string | null;
  readonly members: readonly string[];
}

export interface FileInfo {
  readonly path: string;
  readonly pkg: string;
  /** The comment block that says what the file is for. */
  readonly header: string;
  readonly lines: number;
  readonly symbols: readonly string[];
  /** Files of the repository it imports. */
  readonly imports: readonly string[];
  readonly importedBy: readonly string[];
}

/** One function reaching another: a call, or a React component rendering another. */
export interface CallEdge {
  /** The calling symbol, or the file for top-level code. */
  readonly from: string;
  readonly to: string;
  readonly kind: "call" | "render";
  /** Where, in the caller's file (the first time). */
  readonly line: number;
  /** The name as written at the call, to find it in the source. */
  readonly name: string;
  /** How many calls in the caller reach it. */
  readonly count: number;
}

export interface ColumnInfo {
  /** The property in the Drizzle schema. */
  readonly key: string;
  /** The column in Postgres. */
  readonly column: string;
  /** The Drizzle type or helper: `uuid`, `text`, `jsonb`, `createdAt`. */
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly array: boolean;
  readonly defaultValue: string | null;
  /** A table this column points at, by name. */
  readonly references: string | null;
  readonly doc: string;
}

export interface TableInfo {
  readonly name: string;
  /** The Drizzle variable, e.g. `threadMember`. */
  readonly variable: string;
  readonly file: string;
  readonly line: number;
  readonly doc: string;
  readonly columns: readonly ColumnInfo[];
  readonly foreignKeys: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly table: string;
  }[];
  readonly constraints: readonly { readonly kind: string; readonly name: string }[];
  /** Has `workspace_id` and row-level security (hard rule 3). */
  readonly tenant: boolean;
}

export interface EnumInfo {
  readonly name: string;
  readonly variable: string;
  readonly values: readonly string[];
  readonly file: string;
  readonly line: number;
  readonly doc: string;
}

export interface RouteInfo {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full path, e.g. `/api/threads/:id/messages`. */
  readonly path: string;
  readonly file: string;
  readonly line: number;
  /** The function that defines it, e.g. `apps/api/src/routes/threads.ts#threadRoutes`. */
  readonly owner: string;
  /** From the route list in that function's doc comment, when it has one. */
  readonly doc: string;
}

export interface EventInfo {
  readonly key: string;
  /** `agent/message.received` */
  readonly name: string;
  readonly doc: string;
  readonly file: string;
  readonly line: number;
}

export interface JobInfo {
  /** The Inngest function ID, e.g. `agent-run`. */
  readonly id: string;
  readonly name: string;
  /** Event names and cron schedules that start it. */
  readonly triggers: readonly string[];
  readonly file: string;
  readonly line: number;
  readonly owner: string;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly file: string;
  readonly line: number;
  readonly owner: string;
}

export interface CodeIndex {
  readonly generatedAt: string;
  readonly packages: readonly PackageInfo[];
  readonly files: Readonly<Record<string, FileInfo>>;
  readonly symbols: Readonly<Record<string, SymbolInfo>>;
  readonly calls: readonly CallEdge[];
  readonly tables: readonly TableInfo[];
  readonly enums: readonly EnumInfo[];
  readonly routes: readonly RouteInfo[];
  readonly events: readonly EventInfo[];
  readonly jobs: readonly JobInfo[];
  readonly tools: readonly ToolInfo[];
}

/** A package's source files by path: loaded only when a page shows code. */
export type SourceChunk = Readonly<Record<string, string>>;
