import { firstRunSetupRequestSchema, type SessionResponse } from "@ofa/contracts";
import { Hono, type MiddlewareHandler } from "hono";
import { requestMeta, setCookies } from "../lib/request";
import { readJson } from "../lib/validate";
import type { SessionService } from "../services/sessions";
import type { SetupService } from "../services/setup";
import type { AppEnv } from "../types";

/**
 * First-run setup (public until done):
 *   GET  /api/setup  → { needsSetup }
 *   POST /api/setup  → creates owner + workspace, signs in, returns the session
 */
export function setupRoutes(deps: {
  setup: SetupService;
  sessions: SessionService;
  limiter: MiddlewareHandler<AppEnv>;
}) {
  return new Hono<AppEnv>()
    .get("/", async (c) => c.json(await deps.setup.status()))
    .post("/", deps.limiter, async (c) => {
      const input = await readJson(c, firstRunSetupRequestSchema);
      const { workspaceId } = await deps.setup.run(input, requestMeta(c));

      const { user, cookies } = await deps.sessions.signIn(
        { email: input.email, password: input.password },
        c.req.raw.headers,
      );
      setCookies(c, cookies);
      c.get("logger").info("first-run setup complete", { workspaceId });

      const body: SessionResponse = {
        user,
        workspace: { id: workspaceId, name: input.workspaceName, role: "owner" },
      };
      return c.json(body, 201);
    });
}
