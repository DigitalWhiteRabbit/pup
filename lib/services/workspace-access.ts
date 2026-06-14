import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkModuleAccess } from "@/lib/module-access";
import type { ServiceScope } from "@/lib/services/service-account.service";

/**
 * Unified workspace-access guard.
 *
 * One choke-point for "may this caller touch this workspace (and module)?".
 * Three caller kinds, by explicit policy:
 *
 *  - human global ADMIN  → allowed everywhere (sees all, by the owner's decision);
 *  - service account     → ONLY its own bound workspace, never a global-ADMIN
 *                          bypass on internal routes; if a `scope` is required and
 *                          the token lacks it → 403. Service tokens are not owners
 *                          and have no per-module allow-list (scopes gate them);
 *  - regular user        → must be a workspace member; if `module` is given, the
 *                          member's allowedModules must permit it.
 *
 * Throws ApiError(403) with stable codes: WORKSPACE_FORBIDDEN / MODULE_FORBIDDEN /
 * SCOPE_FORBIDDEN. Returns the resolved access on success.
 */

/** Minimal caller context. Compatible with resolve-auth's AuthContext, and
 *  buildable from a NextAuth session via {@link accessCtxFromSession}. */
export type AccessCtx =
  | { type: "user"; id: string; role: string }
  | {
      type: "service";
      id: string;
      workspaceId: string;
      scopes: ServiceScope[];
    };

export type WorkspaceAccess = {
  kind: "user" | "service";
  /** Membership role for a regular member; null for global-admin and services. */
  role: "OWNER" | "MEMBER" | null;
  isGlobalAdmin: boolean;
  /** Parsed allowedModules for a restricted member; null = full access. */
  allowedModules: string[] | null;
};

export type RequireOpts = {
  /** Module key to gate against the member's allowedModules (users only). */
  module?: string;
  /** Scope a service-account token must hold to pass. */
  scope?: ServiceScope;
  /** Require the user to be the workspace OWNER (global ADMIN still passes). */
  requireOwner?: boolean;
};

export async function requireWorkspaceAccess(
  ctx: AccessCtx,
  workspaceId: string,
  opts: RequireOpts = {},
): Promise<WorkspaceAccess> {
  // ── Service account: bound to its OWN workspace, scope-gated, never a global
  //    admin on internal routes. ──────────────────────────────────────────────
  if (ctx.type === "service") {
    if (ctx.workspaceId !== workspaceId) {
      throw new ApiError(
        "Service account not authorized for this workspace",
        "WORKSPACE_FORBIDDEN",
        403,
      );
    }
    if (opts.scope && !ctx.scopes.includes(opts.scope)) {
      throw new ApiError(
        `Service account lacks scope: ${opts.scope}`,
        "SCOPE_FORBIDDEN",
        403,
      );
    }
    if (opts.requireOwner) {
      throw new ApiError(
        "Owner-only operation — not permitted for service accounts",
        "WORKSPACE_FORBIDDEN",
        403,
      );
    }
    return {
      kind: "service",
      role: null,
      isGlobalAdmin: false,
      allowedModules: null,
    };
  }

  // ── Human global ADMIN: sees everything (owner's decision). ────────────────
  if (ctx.role === "ADMIN") {
    return {
      kind: "user",
      role: null,
      isGlobalAdmin: true,
      allowedModules: null,
    };
  }

  // ── Regular user: must be a member of this workspace. ──────────────────────
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: ctx.id } },
    select: { role: true, allowedModules: true },
  });
  if (!member) {
    throw new ApiError("Нет доступа к workspace", "WORKSPACE_FORBIDDEN", 403);
  }
  if (opts.requireOwner && member.role !== "OWNER") {
    throw new ApiError("Только владелец workspace", "WORKSPACE_FORBIDDEN", 403);
  }

  // OWNER → full module access; otherwise parse the JSON allowedModules string
  // (null / malformed → full access, matching existing lenient behaviour).
  let allowedModules: string[] | null = null;
  if (member.role !== "OWNER" && member.allowedModules) {
    try {
      const parsed = JSON.parse(member.allowedModules) as unknown;
      if (Array.isArray(parsed)) allowedModules = parsed as string[];
    } catch {
      /* malformed → null = full access */
    }
  }

  if (opts.module && !checkModuleAccess(allowedModules, opts.module)) {
    throw new ApiError(
      `Нет доступа к модулю: ${opts.module}`,
      "MODULE_FORBIDDEN",
      403,
    );
  }

  return {
    kind: "user",
    role: member.role,
    isGlobalAdmin: false,
    allowedModules,
  };
}

/** Build an AccessCtx from a NextAuth session (internal routes using auth()). */
export function accessCtxFromSession(session: {
  user: { id: string; role?: string | null };
}): AccessCtx {
  return {
    type: "user",
    id: session.user.id,
    role: session.user.role ?? "USER",
  };
}
