/**
 * voice-access.ts — centralized authorization for Voice routes (P0 fix).
 *
 * Previously NO voice route checked workspace membership, and every route
 * loaded rooms/sessions by bare id (cross-workspace IDOR). These helpers are
 * the single place that enforces:
 *  - member-only routes: caller must be a workspace member (ADMIN bypass kept
 *    for parity with sibling internal /api/workspaces/[id]/* routes; the global
 *    ADMIN-bypass question is tracked separately in P0 #3);
 *  - guest-capable routes: a no-session caller must present a valid signed
 *    invite token bound to this (workspaceId, roomId);
 *  - room/session lookups are scoped to the workspace (no bare-id IDOR).
 */
import "server-only";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "@/lib/services/membership-check";
import { verifyVoiceInvite } from "@/lib/services/voice-invite";

/** Member-only gate. Throws 403 if the user is not a workspace member. */
export async function assertMember(
  workspaceId: string,
  userId: string,
  role: string | undefined,
): Promise<void> {
  if (role === "ADMIN") return; // parity with sibling internal routes (see P0 #3)
  const membership = await checkMembership(workspaceId, userId);
  if (!membership) {
    throw new ApiError("Доступ запрещён", "WORKSPACE_FORBIDDEN", 403);
  }
}

/**
 * Load a room and assert it belongs to the workspace from the URL.
 * Prevents acting on another workspace's room via a bare roomId.
 */
export async function loadRoomInWorkspace(roomId: string, workspaceId: string) {
  const room = await db.voiceRoom.findUnique({ where: { id: roomId } });
  if (!room || room.workspaceId !== workspaceId) {
    throw new ApiError("Room not found", "NOT_FOUND", 404);
  }
  return room;
}

export type VoiceAccess =
  | { isGuest: false; userId: string; role: string }
  | { isGuest: true };

/**
 * Enforce a private room's allow-list for MEMBERS. Guests are intentionally
 * admitted by a valid room-bound invite token (the invite IS the grant), so
 * this is a no-op for guests. Must be called on every route where a member
 * reaches a specific room (list/read/write/invite), not just on join.
 */
export function assertRoomAllowed(
  room: { isPrivate: boolean; allowedUserIds: string },
  access: VoiceAccess,
): void {
  if (access.isGuest) return; // invite token already validated the guest
  if (!room.isPrivate) return;
  let allowed: string[];
  try {
    allowed = JSON.parse(room.allowedUserIds) as string[];
  } catch {
    // Corrupt allow-list on a PRIVATE room → deny (fail closed).
    throw new ApiError(
      "Нет доступа к приватному каналу",
      "ROOM_FORBIDDEN",
      403,
    );
  }
  if (!Array.isArray(allowed) || !allowed.includes(access.userId)) {
    throw new ApiError(
      "Нет доступа к приватному каналу",
      "ROOM_FORBIDDEN",
      403,
    );
  }
}

/**
 * Gate a guest-capable route. A logged-in user must be a workspace member;
 * a no-session caller must present a valid signed invite token bound to this
 * (workspaceId, roomId). Returns the resolved access (isGuest flag).
 *
 * NOTE: callers must still load the room scoped to the workspace
 * (loadRoomInWorkspace) and apply per-room private allow-list for members.
 */
export async function resolveVoiceAccess(opts: {
  session: { user?: { id?: string; role?: string } } | null;
  workspaceId: string;
  roomId: string;
  inviteToken: string | undefined | null;
}): Promise<VoiceAccess> {
  const userId = opts.session?.user?.id;
  if (userId) {
    await assertMember(opts.workspaceId, userId, opts.session?.user?.role);
    return { isGuest: false, userId, role: opts.session?.user?.role ?? "USER" };
  }
  // Guest: require a valid signed invite token bound to this room.
  if (!verifyVoiceInvite(opts.inviteToken, opts.workspaceId, opts.roomId)) {
    throw new ApiError("Invalid or expired invite", "INVITE_INVALID", 403);
  }
  return { isGuest: true };
}

/** Map a thrown error to a NextResponse-friendly {status, body}. */
export function voiceErrorResponse(err: unknown): {
  status: number;
  body: { error: string; code?: string };
} {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: err.message, code: err.code } };
  }
  console.error("[voice]", err);
  return { status: 500, body: { error: "Ошибка сервера" } };
}
