import { loginRequestSchema, type SessionResponse } from "@ofa/contracts";
import { asId, type WorkspaceId } from "@ofa/core";
import { recordAudit, type Database, type WorkspaceMembership } from "@ofa/db";
import { Hono, type MiddlewareHandler } from "hono";
import { requestMeta, setCookies } from "../lib/request";
import { readJson } from "../lib/validate";
import { requireSession } from "../middleware/session";
import type { SessionService, SessionUser } from "../services/sessions";
import type { AppEnv } from "../types";

function toResponse(user: SessionUser, membership: WorkspaceMembership | null): SessionResponse {
  return {
    user,
    workspace: membership
      ? { id: membership.workspaceId, name: membership.workspaceName, role: membership.role }
      : null,
  };
}

/**
 * The signed-in session:
 *   POST   /api/session  log in (email + password), sets the session cookie
 *   GET    /api/session  who am I, and which workspace
 *   DELETE /api/session  log out
 */
export function sessionRoutes(deps: {
  db: Database;
  sessions: SessionService;
  limiter: MiddlewareHandler<AppEnv>;
}) {
  return new Hono<AppEnv>()
    .post("/", deps.limiter, async (c) => {
      const input = await readJson(c, loginRequestSchema);
      const { user, cookies } = await deps.sessions.signIn(input, c.req.raw.headers);
      setCookies(c, cookies);

      const [membership] = await deps.sessions.membershipsOf(user.id);
      if (membership) {
        await recordAudit(
          deps.db,
          { workspaceId: asId<WorkspaceId>(membership.workspaceId), userId: user.id },
          { action: "session.created", targetType: "user", targetId: user.id, ...requestMeta(c) },
        );
      }
      return c.json(toResponse(user, membership ?? null));
    })
    .get("/", requireSession(deps.sessions), (c) => {
      const { user, membership } = c.get("session");
      return c.json(toResponse(user, membership));
    })
    .delete("/", async (c) => {
      setCookies(c, await deps.sessions.signOut(c.req.raw.headers));
      return c.body(null, 204);
    });
}
