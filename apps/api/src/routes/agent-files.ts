import { agentFileRootSchema, type AgentFileList, type AgentFileRoot } from "@ofa/contracts";
import { AppError, NotFoundError, SandboxError, type AgentId, type TenantContext } from "@ofa/core";
import { getAgent } from "@ofa/db";
import { Hono } from "hono";
import type { Container } from "../container";
import { requireSession, requireTenant } from "../middleware/session";
import type { AppEnv } from "../types";

/**
 * An agent's files, for the Files tab in the computer panel (DT.08):
 *   GET /api/agents/:id/files?root=workspace|home&path=       a folder
 *   GET /api/agents/:id/files/content?root=…&path=            a file, as a download
 *
 * `workspace` is the folder all agents share; `home` the agent's own. Paths
 * are relative to the root. Hidden files and folders (its runtime, venv and
 * settings) and its browser profile (cookies, logins) are never listed or
 * served, and `..` never leaves the root. Files may come from outside, so
 * like artifacts they are always a download: attachment, nosniff, and a
 * sandboxing CSP.
 */

/** Folders in an agent's home that are its own machinery, not its work. */
const HOME_HIDDEN = new Set(["chromium", "Desktop"]);

/** The sandbox path for a person's view, or null when it reaches what the Files tab never shows. */
export function agentFilePath(root: AgentFileRoot, relative: string): string | null {
  const parts = relative.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || part.startsWith(".") || part.includes("\0"))) {
    return null;
  }
  if (root === "home" && parts[0] && HOME_HIDDEN.has(parts[0])) return null;
  const base = root === "workspace" ? "/workspace" : "~";
  return parts.length > 0 ? `${base}/${parts.join("/")}` : base;
}

function query(c: { req: { query(name: string): string | undefined } }) {
  const root = agentFileRootSchema.safeParse(c.req.query("root") ?? "workspace");
  if (!root.success) throw new AppError("bad_request", "root must be workspace or home");
  const relative = (c.req.query("path") ?? "").slice(0, 4_096);
  const path = agentFilePath(root.data, relative);
  if (path === null) throw new NotFoundError("File");
  return { root: root.data, relative: relative.replace(/^\/+|\/+$/g, ""), path };
}

export function agentFileRoutes(deps: Pick<Container, "db" | "sessions" | "sandbox">) {
  async function computer(tenant: TenantContext, agentId: string) {
    if (!deps.sandbox) throw new NotFoundError("Computer");
    const agent = await getAgent(deps.db, tenant, agentId);
    if (!agent) throw new NotFoundError("Agent");
    return { handle: await deps.sandbox.acquire(tenant), agentId: agent.id as AgentId };
  }

  const missing = (error: unknown) => {
    if (error instanceof SandboxError && error.code === "not_found")
      throw new NotFoundError("File");
    if (error instanceof SandboxError && error.code === "too_large") {
      throw new AppError("bad_request", "The file is larger than 10 MB");
    }
    throw error;
  };

  return new Hono<AppEnv>()
    .use(requireSession(deps.sessions), requireTenant())
    .get("/:id/files", async (c) => {
      const { root, relative, path } = query(c);
      const { handle, agentId } = await computer(c.get("tenant"), c.req.param("id"));
      const listed = await handle.listFiles(agentId, path).catch(missing);
      const entries = listed.entries
        .filter((e) => !e.name.startsWith("."))
        .filter((e) => !(root === "home" && relative === "" && HOME_HIDDEN.has(e.name)))
        .sort(
          (a, b) =>
            Number(b.type === "directory") - Number(a.type === "directory") ||
            a.name.localeCompare(b.name),
        );
      return c.json({
        root,
        path: relative,
        entries,
        truncated: listed.truncated,
      } satisfies AgentFileList);
    })
    .get("/:id/files/content", async (c) => {
      const { path } = query(c);
      const { handle, agentId } = await computer(c.get("tenant"), c.req.param("id"));
      const content = await handle.readFile(agentId, path).catch(missing);
      const name =
        (path.split("/").pop() ?? "file").replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
      return c.body(Buffer.from(content), 200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "no-store",
      });
    });
}
