import "server-only";

import { auth } from "@/lib/auth";
import {
  verifyToken,
  type ServiceScope,
} from "@/lib/services/service-account.service";
import { checkServiceAccountRateLimit } from "@/lib/services/auth/service-account-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";

// ─── Unified auth context ────────────────────────────────────────────────────

export type AuthContext =
  | {
      type: "user";
      id: string;
      role: string;
      login: string;
    }
  | {
      type: "service";
      id: string;
      /**
       * Service tokens carry role "ADMIN" ONLY so the legacy `role !== "ADMIN"`
       * membership shortcut in v1 services lets the token operate inside its OWN
       * (token-bound) workspace — `requireWorkspace`/`requireWorkspaceAccess`
       * have already pinned it there. This is NOT a global-admin / cross-tenant
       * signal: internal guards must branch on `ctx.type === "service"` (see
       * requireWorkspaceAccess), never treat a service token as a human ADMIN.
       */
      role: "ADMIN";
      login: string;
      scopes: ServiceScope[];
      workspaceId: string;
    };

/**
 * Resolve authentication from either Bearer token (service account)
 * or session cookie (user). Returns null if neither is valid.
 *
 * For service accounts, also validates:
 * - Token is active
 * - IP whitelist (if configured)
 * - Rate limit (1000 req/hour)
 */
export async function resolveAuth(
  req: NextRequest,
): Promise<AuthContext | null> {
  // 1. Try Bearer token first (M2M)
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token) {
      return resolveServiceAuth(token, req);
    }
  }

  // 2. Fallback to session cookie
  const session = await auth();
  if (session?.user?.id) {
    return {
      type: "user",
      id: session.user.id,
      role: (session.user as { role?: string }).role ?? "USER",
      login:
        (session.user as { login?: string }).login ??
        session.user.email ??
        "unknown",
    };
  }

  return null;
}

async function resolveServiceAuth(
  token: string,
  req: NextRequest,
): Promise<AuthContext | null> {
  const sa = await verifyToken(token);
  if (!sa) return null;

  // IP whitelist check
  if (sa.allowedIPs && sa.allowedIPs.length > 0) {
    const clientIP =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";

    if (!sa.allowedIPs.includes(clientIP)) {
      throw new ApiError(
        `IP ${clientIP} not in allowedIPs`,
        "IP_FORBIDDEN",
        403,
      );
    }
  }

  // Rate limit check
  const rl = checkServiceAccountRateLimit(sa.id);
  if (!rl.allowed) {
    throw new ServiceRateLimitError(rl.retryAfter ?? 3600, rl.remaining);
  }

  return {
    type: "service",
    id: sa.id,
    role: "ADMIN",
    login: `service:${sa.name}`,
    scopes: sa.scopes,
    workspaceId: sa.workspaceId,
  };
}

/** Check if context has a specific scope (users always pass) */
export function requireScope(ctx: AuthContext, scope: ServiceScope): void {
  if (ctx.type === "user") return;
  if (!ctx.scopes.includes(scope)) {
    throw new ApiError(
      `Service account lacks scope: ${scope}`,
      "SCOPE_FORBIDDEN",
      403,
    );
  }
}

/**
 * For service accounts, enforce that the requested workspace matches
 * the one bound to the token.
 */
export function requireWorkspace(ctx: AuthContext, workspaceId: string): void {
  if (ctx.type === "service" && ctx.workspaceId !== workspaceId) {
    throw new ApiError(
      "Service account not authorized for this workspace",
      "WORKSPACE_FORBIDDEN",
      403,
    );
  }
}

/** Build rate limit headers for response */
export function rateLimitHeaders(ctx: AuthContext): Record<string, string> {
  if (ctx.type !== "service") return {};
  const rl = checkServiceAccountRateLimit(ctx.id);
  return {
    "X-RateLimit-Remaining": String(rl.remaining),
  };
}

/** Convenience: return 401 JSON response */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// ─── Custom error for rate limiting ──────────────────────────────────────────

export class ServiceRateLimitError extends Error {
  constructor(
    public readonly retryAfter: number,
    public readonly remaining: number,
  ) {
    super("Rate limit exceeded");
    this.name = "ServiceRateLimitError";
  }

  toResponse(): NextResponse {
    return NextResponse.json(
      { error: "Rate limit exceeded", retryAfter: this.retryAfter },
      {
        status: 429,
        headers: {
          "Retry-After": String(this.retryAfter),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }
}
