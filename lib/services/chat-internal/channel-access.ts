/**
 * channel-access.ts — channel-level authorization for internal workspace chat (P0).
 *
 * Before this, chat routes/SSE gated on WORKSPACE membership only, so any
 * workspace member could read/operate on PRIVATE channels and DMs they were not
 * part of, address channels of OTHER workspaces by bare id, and SSE pushed full
 * PRIVATE/DM content to every workspace client. These helpers are the single
 * place that enforces:
 *  - the channel belongs to the route's workspace (kills cross-ws channelId IDOR);
 *  - PRIVATE / DM → caller must be a channel member;
 *  - PUBLIC / GENERAL → any workspace member.
 *
 * ADMIN bypass is kept for parity with sibling internal routes; the unified
 * platform-ADMIN policy (incl. NOT letting a global ADMIN read DMs via explicit
 * ops) is tracked separately in P0 #3. NOTE: SSE *delivery* (sse.service) is
 * intentionally NOT given this ADMIN bypass — it pushes only to actual channel
 * members so DM/private content is never fanned out to non-member admins.
 */
import "server-only";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "@/lib/services/membership-check";

type ChannelRow = {
  id: string;
  workspaceId: string;
  type: "GENERAL" | "PUBLIC" | "PRIVATE" | "DM";
};

/**
 * Assert the caller may access `channelId` within `workspaceId`.
 * Returns the channel row. Throws 404 (cross-ws / missing) or 403 (no access).
 */
export async function assertChannelAccess(
  channelId: string,
  workspaceId: string,
  userId: string,
  role?: string,
): Promise<ChannelRow> {
  const ch = (await db.chatChannel.findUnique({
    where: { id: channelId },
    select: { id: true, workspaceId: true, type: true },
  })) as ChannelRow | null;

  // Cross-workspace IDOR: a channel from another workspace is "not found" here.
  if (!ch || ch.workspaceId !== workspaceId) {
    throw new ApiError("Канал не найден", "NOT_FOUND", 404);
  }

  if (role === "ADMIN") return ch; // parity with sibling internal routes (P0 #3)

  if (ch.type === "PRIVATE" || ch.type === "DM") {
    const member = await db.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { userId: true },
    });
    if (!member) {
      throw new ApiError("Нет доступа к каналу", "CHANNEL_FORBIDDEN", 403);
    }
  } else {
    // PUBLIC / GENERAL — any member of the workspace.
    const wm = await checkMembership(workspaceId, userId);
    if (!wm) throw new ApiError("Доступ запрещён", "WORKSPACE_FORBIDDEN", 403);
  }
  return ch;
}

/**
 * Same as assertChannelAccess but starting from a messageId — resolves the
 * message's channel, asserts it belongs to the workspace, and checks access.
 * Closes the "edit/delete/react/bookmark/pin operate on a bare messageId"
 * gap. Returns the message's channelId + authorId.
 */
export async function assertMessageChannelAccess(
  messageId: string,
  workspaceId: string,
  userId: string,
  role?: string,
): Promise<{ channelId: string; authorId: string }> {
  const msg = await db.chatMsg.findUnique({
    where: { id: messageId },
    select: { channelId: true, authorId: true },
  });
  if (!msg) throw new ApiError("Сообщение не найдено", "NOT_FOUND", 404);
  await assertChannelAccess(msg.channelId, workspaceId, userId, role);
  return msg;
}

/**
 * Resolve SSE delivery scope for a channel: workspaceId + the user ids that
 * should receive message-level events. `recipients = null` means "all workspace
 * clients" (PUBLIC/GENERAL); for PRIVATE/DM it's the channel members only.
 */
export async function resolveChannelDelivery(
  channelId: string,
): Promise<{ workspaceId: string; recipients: string[] | null } | null> {
  const ch = await db.chatChannel.findUnique({
    where: { id: channelId },
    select: {
      workspaceId: true,
      type: true,
      members: { select: { userId: true } },
    },
  });
  if (!ch) return null;
  const recipients =
    ch.type === "PRIVATE" || ch.type === "DM"
      ? ch.members.map((m) => m.userId)
      : null;
  return { workspaceId: ch.workspaceId, recipients };
}
