import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { handleColumnRename } from "./timer.service";
import { notify } from "./notification.service";
import {
  logActivity,
  notifyCriticalEvent,
  generateSummary,
} from "./logger.service";
import type { MemberRole } from "@prisma/client";

// ─── Slug generation ─────────────────────────────────────────────────────────

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || "ws"}-${suffix}`;
}

// ─── Module constants ─────────────────────────────────────────────────────────

const DEFAULT_MODULES = [
  "crm",
  "knowledge",
  "tickets",
  "logs",
  "chat",
  "marketing",
  "analytics",
  "users",
] as const;

export type ModuleKey = (typeof DEFAULT_MODULES)[number];

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkspaceSummary = {
  id: string;
  name: string;
  description: string | null;
  hasLogo: boolean;
  owner: { id: string; login: string };
  memberCount: number;
  createdAt: Date;
};

export type WorkspaceBoard = {
  id: string;
  name: string;
  description: string | null;
  logoPath: string | null;
  owner: { id: string; login: string };
  members: Array<{
    id: string;
    login: string;
    email: string;
    role: MemberRole;
  }>;
  columns: Array<{
    id: string;
    name: string;
    position: number;
    tasks: Array<{
      id: string;
      columnId: string;
      title: string;
      description: string | null;
      priority: string;
      position: number;
      startDate: Date | null;
      dueDate: Date | null;
      assignees: Array<{ id: string; login: string; isActive: boolean }>;
      labels: Array<{ id: string; name: string; color: string }>;
      checklistTotal: number;
      checklistDone: number;
      totalTimeMs: number;
      isInProgress: boolean;
      lastIntervalStartedAt: Date | null;
      createdAt: Date;
    }>;
  }>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export type MembershipRole = "OWNER" | "MEMBER" | null;

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

// ─── createWorkspace ──────────────────────────────────────────────────────────

export async function createWorkspace(input: {
  name: string;
  description?: string;
  ownerId: string;
}): Promise<{
  id: string;
  name: string;
  description: string | null;
  columns: Array<{ id: string; name: string; position: number }>;
}> {
  const result = await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: input.name,
        slug: generateSlug(input.name),
        description: input.description ?? null,
        ownerId: input.ownerId,
      },
    });

    const columns = await Promise.all([
      tx.column.create({
        data: { workspaceId: workspace.id, name: "Ожидает", position: 0 },
      }),
      tx.column.create({
        data: { workspaceId: workspace.id, name: "В работе", position: 1 },
      }),
      tx.column.create({
        data: { workspaceId: workspace.id, name: "Готово", position: 2 },
      }),
    ]);

    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: input.ownerId, role: "OWNER" },
    });

    await tx.workspaceModule.createMany({
      data: DEFAULT_MODULES.map((moduleKey) => ({
        workspaceId: workspace.id,
        moduleKey,
        enabled: true,
      })),
    });

    return { workspace, columns };
  });

  await logActivity({
    workspaceId: result.workspace.id,
    actorId: input.ownerId,
    action: "WORKSPACE_CREATED",
    entityType: "Workspace",
    entityId: result.workspace.id,
    summary: generateSummary("WORKSPACE_CREATED", {
      workspaceName: result.workspace.name,
    }),
    metadata: { workspaceName: result.workspace.name },
  });

  return {
    id: result.workspace.id,
    name: result.workspace.name,
    description: result.workspace.description,
    columns: result.columns.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
    })),
  };
}

// ─── getWorkspacesForUser ─────────────────────────────────────────────────────

export async function getWorkspacesForUser(
  userId: string,
  role: "ADMIN" | "USER",
  page: number,
  pageSize: number,
): Promise<{
  data: WorkspaceSummary[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const where = role === "ADMIN" ? {} : { members: { some: { userId } } };

  const [workspaces, total] = await db.$transaction([
    db.workspace.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        owner: { select: { id: true, login: true } },
        _count: { select: { members: true } },
      },
    }),
    db.workspace.count({ where }),
  ]);

  return {
    data: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      hasLogo: !!w.logoPath,
      owner: w.owner,
      memberCount: w._count.members,
      createdAt: w.createdAt,
    })),
    total,
    page,
    pageSize,
  };
}

// ─── getWorkspaceById ─────────────────────────────────────────────────────────

export async function getWorkspaceById(
  id: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<WorkspaceBoard> {
  const workspace = await db.workspace.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, login: true } },
      members: {
        include: { user: { select: { id: true, login: true, email: true } } },
        orderBy: { joinedAt: "asc" },
      },
      columns: {
        orderBy: { position: "asc" },
        include: {
          tasks: {
            orderBy: { position: "asc" },
            take: 100,
            include: {
              assignees: {
                include: {
                  user: { select: { id: true, login: true, isActive: true } },
                },
              },
              labels: { include: { label: true } },
              checklistItems: { select: { checked: true } },
            },
          },
        },
      },
    },
  });

  if (!workspace) {
    throw new ApiError("Workspace не найден", "NOT_FOUND", 404);
  }

  if (userRole !== "ADMIN") {
    const isMember = workspace.members.some((m) => m.userId === userId);
    if (!isMember) {
      throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
    }
  }

  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description,
    logoPath: workspace.logoPath,
    owner: workspace.owner,
    members: workspace.members.map((m) => ({
      id: m.user.id,
      login: m.user.login,
      email: m.user.email,
      role: m.role,
    })),
    columns: workspace.columns.map((col) => ({
      id: col.id,
      name: col.name,
      position: col.position,
      tasks: col.tasks.map((task) => {
        // timeIntervals excluded from board query for performance;
        // detailed time data loads on-demand when TaskModal opens
        const totalTimeMs = 0;
        const isInProgress = false;
        const lastIntervalStartedAt = null;
        return {
          id: task.id,
          columnId: col.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          position: task.position,
          startDate: task.startDate,
          dueDate: task.dueDate,
          assignees: task.assignees.map((a) => a.user),
          labels: task.labels.map((tl) => tl.label),
          checklistTotal: task.checklistItems.length,
          checklistDone: task.checklistItems.filter((i) => i.checked).length,
          totalTimeMs,
          isInProgress,
          lastIntervalStartedAt,
          createdAt: task.createdAt,
        };
      }),
    })),
  };
}

// ─── updateWorkspace ──────────────────────────────────────────────────────────

export async function updateWorkspace(
  id: string,
  data: { name?: string; description?: string | null },
  userId: string,
): Promise<{ id: string; name: string; description: string | null }> {
  const membership = await checkMembership(id, userId);
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец может редактировать workspace",
      "FORBIDDEN",
      403,
    );
  }

  const updated = await db.workspace.update({
    where: { id },
    data,
    select: { id: true, name: true, description: true },
  });

  await logActivity({
    workspaceId: id,
    actorId: userId,
    action: "WORKSPACE_UPDATED",
    entityType: "Workspace",
    entityId: id,
    summary: generateSummary("WORKSPACE_UPDATED", {}),
    metadata: { changes: data },
  });

  return updated;
}

// ─── deleteWorkspace ──────────────────────────────────────────────────────────

export async function deleteWorkspace(
  id: string,
  userId: string,
): Promise<void> {
  const membership = await checkMembership(id, userId);
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец может удалить workspace",
      "FORBIDDEN",
      403,
    );
  }

  const workspace = await db.workspace.findUnique({
    where: { id },
    select: {
      name: true,
      members: { select: { userId: true } },
    },
  });

  const workspaceName = workspace?.name ?? "?";
  const memberIds = workspace?.members.map((m) => m.userId) ?? [];

  // Stop marketing worker before deletion so it doesn't keep running against a deleted workspace
  try {
    const { stop: stopWorker } = await import("./marketing/mkt-worker.service");
    await stopWorker();
  } catch {
    // Worker may not be running or module may not be loaded — safe to ignore
  }

  await db.workspace.delete({ where: { id } });

  void notifyCriticalEvent({
    action: "WORKSPACE_DELETED",
    memberIds,
    workspaceName,
    actorLogin: userId,
  });
}

// ─── addMember ────────────────────────────────────────────────────────────────

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

// ─── removeMember ─────────────────────────────────────────────────────────────

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

// ─── Column service ────────────────────────────────────────────────────────────

export async function createColumn(input: {
  workspaceId: string;
  name: string;
  requesterId: string;
  requesterRole: "ADMIN" | "USER";
}): Promise<{ id: string; name: string; position: number }> {
  const membership = await checkMembership(
    input.workspaceId,
    input.requesterId,
  );
  if (!membership && input.requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const maxCol = await db.column.findFirst({
    where: { workspaceId: input.workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = maxCol ? maxCol.position + 1 : 0;

  const column = await db.column.create({
    data: { workspaceId: input.workspaceId, name: input.name, position },
    select: { id: true, name: true, position: true },
  });

  const actor = await db.user.findUnique({
    where: { id: input.requesterId },
    select: { login: true },
  });

  await logActivity({
    workspaceId: input.workspaceId,
    actorId: input.requesterId,
    action: "COLUMN_CREATED",
    entityType: "Column",
    entityId: column.id,
    columnId: column.id,
    summary: generateSummary("COLUMN_CREATED", {
      actorLogin: actor?.login,
      columnName: input.name,
    }),
    metadata: { columnName: input.name, position },
  });

  return column;
}

export async function renameColumn(
  columnId: string,
  newName: string,
  requesterId: string,
  requesterRole: "ADMIN" | "USER",
): Promise<{ id: string; name: string }> {
  const columnCheck = await db.column.findUnique({
    where: { id: columnId },
    select: { workspaceId: true },
  });
  if (!columnCheck) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(
    columnCheck.workspaceId,
    requesterId,
  );
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const { result: renamed, oldName } = await db.$transaction(async (tx) => {
    const column = await tx.column.findUnique({ where: { id: columnId } });
    if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

    const capturedOldName = column.name;

    await tx.column.update({
      where: { id: columnId },
      data: { name: newName },
    });

    await handleColumnRename(tx, columnId, capturedOldName, newName);

    return {
      result: { id: columnId, name: newName },
      oldName: capturedOldName,
    };
  });

  const actor = await db.user.findUnique({
    where: { id: requesterId },
    select: { login: true },
  });

  await logActivity({
    workspaceId: columnCheck.workspaceId,
    actorId: requesterId,
    action: "COLUMN_RENAMED",
    entityType: "Column",
    entityId: columnId,
    columnId,
    summary: generateSummary("COLUMN_RENAMED", {
      actorLogin: actor?.login,
      columnNameOld: oldName,
      columnName: newName,
    }),
    metadata: { columnId, oldName, newName },
  });

  return renamed;
}

export async function deleteColumn(
  columnId: string,
  requesterId: string,
  requesterRole: "ADMIN" | "USER",
): Promise<void> {
  const column = await db.column.findUnique({
    where: { id: columnId },
    include: { _count: { select: { tasks: true } } },
  });
  if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(column.workspaceId, requesterId);
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  if (column._count.tasks > 0) {
    throw new ApiError(
      "Нельзя удалить колонку с задачами. Сначала переместите все задачи.",
      "COLUMN_HAS_TASKS",
      400,
    );
  }

  const actor = await db.user.findUnique({
    where: { id: requesterId },
    select: { login: true },
  });

  await logActivity({
    workspaceId: column.workspaceId,
    actorId: requesterId,
    action: "COLUMN_DELETED",
    entityType: "Column",
    entityId: columnId,
    columnId,
    summary: generateSummary("COLUMN_DELETED", {
      actorLogin: actor?.login,
      columnName: column.name,
    }),
    metadata: { columnId, columnName: column.name },
  });

  await db.column.delete({ where: { id: columnId } });
}

export async function reorderColumn(
  columnId: string,
  newPosition: number,
  requesterId: string,
  requesterRole: "ADMIN" | "USER",
): Promise<{ id: string; position: number }> {
  const column = await db.column.findUnique({
    where: { id: columnId },
    select: { workspaceId: true },
  });
  if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(column.workspaceId, requesterId);
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  await db.column.update({
    where: { id: columnId },
    data: { position: newPosition },
  });

  return { id: columnId, position: newPosition };
}

// ─── Module service ───────────────────────────────────────────────────────────

export async function getEnabledModules(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<ModuleKey[]> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const modules = await db.workspaceModule.findMany({
    where: { workspaceId, enabled: true },
    select: { moduleKey: true },
  });

  return modules.map((m) => m.moduleKey as ModuleKey);
}

export async function getAllModules(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<Array<{ moduleKey: ModuleKey; enabled: boolean }>> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const modules = await db.workspaceModule.findMany({
    where: { workspaceId },
    select: { moduleKey: true, enabled: true },
  });

  return modules.map((m) => ({
    moduleKey: m.moduleKey as ModuleKey,
    enabled: m.enabled,
  }));
}

export async function setModuleEnabled(
  workspaceId: string,
  moduleKey: string,
  enabled: boolean,
  userId: string,
  _userRole: "ADMIN" | "USER",
): Promise<void> {
  const membership = await checkMembership(workspaceId, userId);
  // Only OWNER can toggle modules (not regular ADMIN)
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец workspace может управлять модулями",
      "FORBIDDEN",
      403,
    );
  }

  await db.workspaceModule.upsert({
    where: { workspaceId_moduleKey: { workspaceId, moduleKey } },
    update: { enabled },
    create: { workspaceId, moduleKey, enabled },
  });

  const actor = await db.user.findUnique({
    where: { id: userId },
    select: { login: true },
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    action: enabled ? "MODULE_ENABLED" : "MODULE_DISABLED",
    entityType: "WorkspaceModule",
    summary: generateSummary(enabled ? "MODULE_ENABLED" : "MODULE_DISABLED", {
      actorLogin: actor?.login,
      moduleName: moduleKey,
    }),
    metadata: { moduleKey, enabled },
  });
}

export async function isModuleEnabled(
  workspaceId: string,
  moduleKey: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<boolean> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const mod = await db.workspaceModule.findUnique({
    where: { workspaceId_moduleKey: { workspaceId, moduleKey } },
    select: { enabled: true },
  });

  return mod?.enabled ?? false;
}
