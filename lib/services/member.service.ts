import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import type { MemberRole } from "@prisma/client";

// Dynamic imports to avoid webpack bundling telegram/mailparser chain
// Hidden from webpack static analysis via Function constructor
async function getLogger(): Promise<typeof import("./logger.service")> {
  const p = "./logger.service";
  return Function("p", "return import(p)")(p) as Promise<
    typeof import("./logger.service")
  >;
}
async function getNotifier(): Promise<typeof import("./notification.service")> {
  const p = "./notification.service";
  return Function("p", "return import(p)")(p) as Promise<
    typeof import("./notification.service")
  >;
}

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
  const requester = await db.user.findUnique({
    where: { id: requesterId },
    select: { role: true, login: true },
  });
  const isGlobalAdmin = requester?.role === "ADMIN";
  if (membership !== "OWNER" && !isGlobalAdmin) {
    throw new ApiError(
      "Только владелец или админ может добавлять участников",
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

  // Add the new member to the workspace General chat channel. Best-effort (a
  // chat failure must not fail the member add), but AWAITED and logged so it
  // actually runs and errors surface instead of being silently swallowed.
  // (channel.service does not pull the telegram/mailparser chain, so a normal
  // dynamic import is safe here — unlike logger/notification below.)
  try {
    const { addUserToGeneralChannel } =
      await import("./chat-internal/channel.service");
    await addUserToGeneralChannel(workspaceId, user.id);
  } catch (e) {
    console.error("[addMember] add to General chat channel failed:", e);
  }

  await (
    await getNotifier()
  ).notify({
    type: "PROJECT_ADDED",
    recipientId: user.id,
    actorId: requesterId,
    workspaceId,
  });

  await (
    await getLogger()
  ).logActivity({
    workspaceId,
    actorId: requesterId,
    action: "MEMBER_ADDED",
    entityType: "User",
    entityId: user.id,
    summary: (await getLogger()).generateSummary("MEMBER_ADDED", {
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
  const requesterUser = await db.user.findUnique({
    where: { id: requesterId },
    select: { role: true },
  });
  const isGlobalAdmin = requesterUser?.role === "ADMIN";
  if (requesterMembership !== "OWNER" && !isGlobalAdmin) {
    throw new ApiError(
      "Только владелец или админ может удалять участников",
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

  // Remove the user from all chat channels in this workspace (symmetric with
  // add — otherwise a removed member lingers in the General/other channels and
  // keeps receiving realtime messages and unread counts).
  await db.chatChannelMember.deleteMany({
    where: { userId: targetUserId, channel: { workspaceId } },
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

  await (
    await getLogger()
  ).logActivity({
    workspaceId,
    actorId: requesterId,
    action: "MEMBER_REMOVED",
    entityType: "User",
    entityId: targetUserId,
    summary: (await getLogger()).generateSummary("MEMBER_REMOVED", {
      actorLogin: requester?.login,
      targetLogin: targetUser?.login,
    }),
    metadata: { targetUserId, targetLogin: targetUser?.login },
  });

  void (await getLogger()).notifyCriticalEvent({
    action: "MEMBER_REMOVED",
    removedUserId: targetUserId,
    workspaceName: workspace?.name ?? "?",
    actorLogin: requester?.login ?? requesterId,
  });
}

// ─── Module access control ──────────────────────────────────────────────────

/**
 * Get the allowedModules array for a member.
 * Returns null if member has full access, or a string[] of allowed module keys.
 */
export async function getMemberModuleAccess(
  workspaceId: string,
  userId: string,
): Promise<string[] | null> {
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true, allowedModules: true },
  });

  if (!member) return null;

  // OWNERs always have full access
  if (member.role === "OWNER") return null;

  if (!member.allowedModules) return null;

  try {
    const parsed = JSON.parse(member.allowedModules) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

/**
 * Check if a user can access a specific module/sub-module path.
 *
 * Module key format: "moduleKey" | "moduleKey:subKey" | "moduleKey:subKey:tool"
 *
 * Rules:
 * - If allowedModules is null -> true (full access)
 * - If allowedModules contains exact match -> true
 * - If allowedModules contains a parent of the requested path -> true
 *   (e.g. "marketing" allows "marketing:parsers:youtube")
 * - Otherwise -> false
 */
export async function canAccessModule(
  workspaceId: string,
  userId: string,
  moduleKey: string,
): Promise<boolean> {
  const allowed = await getMemberModuleAccess(workspaceId, userId);

  // null = full access
  if (allowed === null) return true;

  return checkModuleAccess(allowed, moduleKey);
}

/**
 * Pure function to check module access against an allowedModules list.
 * Exported for use in frontend without DB calls.
 */
export function checkModuleAccess(
  allowedModules: string[],
  moduleKey: string,
): boolean {
  // Exact match
  if (allowedModules.includes(moduleKey)) return true;

  // Check if any allowed entry is a parent of the requested key
  // e.g. "marketing" allows "marketing:parsers:youtube"
  for (const allowed of allowedModules) {
    if (moduleKey.startsWith(allowed + ":")) return true;
  }

  // Check if any allowed entry is a child of the requested key
  // e.g. if checking "marketing" top-level and user has "marketing:parsers:youtube",
  // they should see the marketing module (but only the allowed sub-tabs inside)
  const requestedPrefix = moduleKey + ":";
  for (const allowed of allowedModules) {
    if (allowed.startsWith(requestedPrefix)) return true;
  }

  return false;
}

/**
 * Update the allowedModules for a member. Only OWNER can do this.
 */
export async function setMemberModuleAccess(
  workspaceId: string,
  targetUserId: string,
  requesterId: string,
  allowedModules: string[] | null,
): Promise<void> {
  const requesterMembership = await checkMembership(workspaceId, requesterId);
  if (requesterMembership !== "OWNER") {
    throw new ApiError(
      "Только владелец может управлять доступом к модулям",
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
      "Нельзя ограничить доступ владельца workspace",
      "CANNOT_RESTRICT_OWNER",
      400,
    );
  }

  await db.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    data: {
      allowedModules:
        allowedModules === null ? null : JSON.stringify(allowedModules),
    },
  });

  const [requester, targetUser] = await Promise.all([
    db.user.findUnique({ where: { id: requesterId }, select: { login: true } }),
    db.user.findUnique({
      where: { id: targetUserId },
      select: { login: true },
    }),
  ]);

  await (
    await getLogger()
  ).logActivity({
    workspaceId,
    actorId: requesterId,
    action: "MEMBER_ROLE_CHANGED",
    entityType: "User",
    entityId: targetUserId,
    summary: (await getLogger()).generateSummary("MEMBER_ROLE_CHANGED", {
      actorLogin: requester?.login,
      targetLogin: targetUser?.login,
    }),
    metadata: {
      targetUserId,
      targetLogin: targetUser?.login,
      allowedModules,
    },
  });
}
