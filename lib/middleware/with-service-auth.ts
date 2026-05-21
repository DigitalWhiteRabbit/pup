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
