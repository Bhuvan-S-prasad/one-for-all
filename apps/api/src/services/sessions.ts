import type { LoginRequest } from "@ofa/contracts";
import {
  AppError,
  asId,
  ForbiddenError,
  type TenantContext,
  type UserId,
  type WorkspaceId,
} from "@ofa/core";
import { listMembershipsForUser, type Database, type WorkspaceMembership } from "@ofa/db";
import { APIError } from "better-auth/api";
import type { Auth } from "../auth/auth";

export interface SessionUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
}

/** A signed-in request, resolved to the workspace it acts in. */
export interface ResolvedSession {
  readonly user: SessionUser;
  readonly membership: WorkspaceMembership | null;
  /** Null only when the user has no membership. */
  readonly tenant: TenantContext | null;
}

export interface SignInResult {
  readonly user: SessionUser;
  /** `Set-Cookie` values to forward to the client. */
  readonly cookies: string[];
}

export interface SessionService {
  signIn(input: LoginRequest, requestHeaders: Headers): Promise<SignInResult>;
  /** Returns `Set-Cookie` values that clear the session cookie. */
  signOut(requestHeaders: Headers): Promise<string[]>;
  /**
   * Resolve the session cookie to a user and a workspace. Uses the requested
   * workspace if given (and the user is a member), otherwise the first one.
   */
  resolve(requestHeaders: Headers, workspaceId?: string): Promise<ResolvedSession | null>;
  membershipsOf(userId: UserId): Promise<WorkspaceMembership[]>;
}

export function createSessionService(deps: { db: Database; auth: Auth }): SessionService {
  const { auth, db } = deps;

  return {
    async signIn(input, requestHeaders) {
      try {
        const { headers, response } = await auth.api.signInEmail({
          body: { email: input.email, password: input.password, rememberMe: true },
          headers: requestHeaders,
          returnHeaders: true,
        });
        return {
          user: {
            id: asId<UserId>(response.user.id),
            email: response.user.email,
            name: response.user.name,
          },
          cookies: headers.getSetCookie(),
        };
      } catch (error) {
        // Same message for unknown email and wrong password.
        if (error instanceof APIError) {
          throw new AppError("unauthorized", "Email or password is incorrect");
        }
        throw error;
      }
    },

    async signOut(requestHeaders) {
      try {
        const { headers } = await auth.api.signOut({ headers: requestHeaders, returnHeaders: true });
        return headers.getSetCookie();
      } catch (error) {
        // No valid session: nothing to sign out of.
        if (error instanceof APIError) return [];
        throw error;
      }
    },

    async resolve(requestHeaders, workspaceId) {
      const data = await auth.api.getSession({ headers: requestHeaders });
      if (!data) return null;

      const userId = asId<UserId>(data.user.id);
      const memberships = await listMembershipsForUser(db, userId);
      const membership = workspaceId
        ? memberships.find((m) => m.workspaceId === workspaceId)
        : memberships[0];
      if (workspaceId && !membership) {
        throw new ForbiddenError("You are not a member of this workspace");
      }

      return {
        user: { id: userId, email: data.user.email, name: data.user.name },
        membership: membership ?? null,
        tenant: membership
          ? { workspaceId: asId<WorkspaceId>(membership.workspaceId), userId }
          : null,
      };
    },

    membershipsOf: (userId) => listMembershipsForUser(db, userId),
  };
}
