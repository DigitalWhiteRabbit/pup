import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import {
  resolveAuth,
  requireScope,
  requireWorkspace,
  rateLimitHeaders,
  unauthorized,
  ServiceRateLimitError,
  type AuthContext,
} from "@/lib/middleware/resolve-auth";
import type { ServiceScope } from "@/lib/services/service-account.service";
import { checkMembership } from "@/lib/services/membership-check";

/**
 * Wraps a v1 API route handler with service account (or user) authentication.
 *
 * Handles:
 * - Bearer token / session resolution
 * - Scope enforcement
 * - Workspace binding enforcement
 * - Rate limit headers on response
 * - Consistent error serialization
 *
 * Usage:
 *   export const GET = withServiceAuth("tasks:read", async (req, workspaceId, ctx) => {
 *     return NextResponse.json({ ok: true });
 *   });
 */
export function withServiceAuth(
  scope: ServiceScope,
  handler: (
    req: NextRequest,
    workspaceId: string,
    ctx: AuthContext,
  ) => Promise<NextResponse>,
) {
  return async (
    req: NextRequest,
    routeCtx: { params: Promise<{ workspaceId: string }> },
  ) => {
    try {
      const ctx = await resolveAuth(req);
      if (!ctx) return unauthorized();

      const { workspaceId } = await routeCtx.params;

      requireScope(ctx, scope);
      requireWorkspace(ctx, workspaceId);

      // P0 (cross-tenant IDOR): a logged-in user reaching the external v1 API
      // must be a MEMBER of the target workspace. requireScope/requireWorkspace
      // are both no-ops for user sessions, so without this any authenticated
      // user could read any workspace by changing the URL id.
      // The external/M2M API is intentionally NOT a place for platform-ADMIN
      // tenant-bypass — even a global ADMIN must be a workspace member here.
      // (Service tokens are already bound to their workspace by requireWorkspace.)
      if (ctx.type === "user") {
        const role = await checkMembership(workspaceId, ctx.id);
        if (!role) {
          throw new ApiError(
            "Forbidden: not a member of this workspace",
            "WORKSPACE_FORBIDDEN",
            403,
          );
        }
      }

      const response = await handler(req, workspaceId, ctx);

      // Attach rate limit headers for service accounts
      const rlHeaders = rateLimitHeaders(ctx);
      for (const [k, v] of Object.entries(rlHeaders)) {
        response.headers.set(k, v);
      }

      return response;
    } catch (err) {
      if (err instanceof ServiceRateLimitError) return err.toResponse();
      if (err instanceof ApiError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status },
        );
      }
      console.error(`[v1/${scope}]`, err);
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
  };
}
