import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { notify } from "./notification.service";
import {
  logActivity,
  notifyCriticalEvent,
  generateSummary,
} from "./logger.service";
import type { MemberRole } from "@prisma/client";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MembershipRole = "OWNER" | "MEMBER" | null;

// ─── checkMembership ─────────────────────────────────────────────────────────

export async function checkMembership(
  workspaceId: string,
  userId: string,
): Promise<MembershipRole> {
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!membership) return null;
  return membership.role;
}

// ─── addMember ───────────────────────────────────────────────────────────────

export async function addMember(
  workspaceId: string,
  loginOrEmail: string,
  requesterId: string,
): Promise<{ userId: string; login: string; email: string; role: MemberRole }> {
  const membership = await checkMembership(workspaceId, requesterId);
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец может добавлять участников",
      "FORBIDDEN",
      403,
    );
  }

  const user = await db.user.findFirst({
    where: { OR: [{ login: loginOrEmail }, { email: loginOrEmail }] },
    select: { id: true, login: true, email: true, isActive: true },
  });

  if (!user) {
    throw new ApiError("Пользователь не найден", "USER_NOT_FOUND", 404);
  }

  if (!user.isActive) {
    throw new ApiError(
      "Нельзя добавить деактивированного пользователя",
      "USER_INACTIVE",
      400,
    );
  }

  const existing = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });

  if (existing) {
    throw new ApiError(
      "Пользователь уже является участником",
      "ALREADY_MEMBER",
      409,
    );
  }

  await db.workspaceMember.create({
    data: { workspaceId, userId: user.id, role: "MEMBER" },
  });

  // Auto-add to General chat channel
  void import("./chat-internal/channel.service")
    .then(({ addUserToGeneralChannel }) =>
      addUserToGeneralChannel(workspaceId, user.id),
    )
    .catch(() => {});

  await notify({
    type: "PROJECT_ADDED",
    recipientId: user.id,
    actorId: requesterId,
    workspaceId,
  });

  const requester = await db.user.findUnique({
    where: { id: requesterId },
    select: { login: true },
  });

  await logActivity({
    workspaceId,
    actorId: requesterId,
    action: "MEMBER_ADDED",
    entityType: "User",
    entityId: user.id,
    summary: generateSummary("MEMBER_ADDED", {
      actorLogin: requester?.login,
      targetLogin: user.login,
    }),
    metadata: { targetUserId: user.id, targetLogin: user.login },
  });

  return {
    userId: user.id,
    login: user.login,
    email: user.email,
    role: "MEMBER",
  };
}

// ─── removeMember ────────────────────────────────────────────────────────────

export async function removeMember(
  workspaceId: string,
  targetUserId: string,
  requesterId: string,
): Promise<void> {
  const requesterMembership = await checkMembership(workspaceId, requesterId);
  if (requesterMembership !== "OWNER") {
    throw new ApiError(
      "Только владелец может удалять участников",
      "FORBIDDEN",
      403,
    );
  }

  const targetMembership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    select: { role: true },
  });

  if (!targetMembership) {
    throw new ApiError("Участник не найден", "MEMBER_NOT_FOUND", 404);
  }

  if (targetMembership.role === "OWNER") {
    throw new ApiError(
      "Нельзя удалить владельца workspace. Сначала передайте права или удалите workspace.",
      "CANNOT_REMOVE_OWNER",
      400,
    );
  }

  // Clean up task assignments for this user in this workspace before removing membership
  await db.taskAssignee.deleteMany({
    where: {
      userId: targetUserId,
      task: { workspaceId },
    },
  });

  await db.workspaceMember.delete({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
  });

  const [requester, targetUser, workspace] = await Promise.all([
    db.user.findUnique({ where: { id: requesterId }, select: { login: true } }),
    db.user.findUnique({
      where: { id: targetUserId },
      select: { login: true },
    }),
    db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    }),
  ]);

  await logActivity({
    workspaceId,
    actorId: requesterId,
    action: "MEMBER_REMOVED",
    entityType: "User",
    entityId: targetUserId,
    summary: generateSummary("MEMBER_REMOVED", {
      actorLogin: requester?.login,
      targetLogin: targetUser?.login,
    }),
    metadata: { targetUserId, targetLogin: targetUser?.login },
  });

  void notifyCriticalEvent({
    action: "MEMBER_REMOVED",
    removedUserId: targetUserId,
    workspaceName: workspace?.name ?? "?",
    actorLogin: requester?.login ?? requesterId,
  });
}
