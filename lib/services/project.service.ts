import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { handleColumnRename, calcTimeFields } from "./timer.service";
import type { MemberRole } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  owner: { id: string; login: string };
  memberCount: number;
  createdAt: Date;
};

export type ProjectBoard = {
  id: string;
  name: string;
  description: string | null;
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
      position: number;
      assignee: { id: string; login: string; isActive: boolean } | null;
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
  projectId: string,
  userId: string,
): Promise<MembershipRole> {
  const membership = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  if (!membership) return null;
  return membership.role;
}

// ─── Service functions ────────────────────────────────────────────────────────

export async function createProject(input: {
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
    const project = await tx.project.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        ownerId: input.ownerId,
      },
    });

    const columns = await Promise.all([
      tx.column.create({
        data: { projectId: project.id, name: "Ожидает", position: 0 },
      }),
      tx.column.create({
        data: { projectId: project.id, name: "В работе", position: 1 },
      }),
      tx.column.create({
        data: { projectId: project.id, name: "Готово", position: 2 },
      }),
    ]);

    await tx.projectMember.create({
      data: { projectId: project.id, userId: input.ownerId, role: "OWNER" },
    });

    return { project, columns };
  });

  return {
    id: result.project.id,
    name: result.project.name,
    description: result.project.description,
    columns: result.columns.map((c) => ({
      id: c.id,
      name: c.name,
      position: c.position,
    })),
  };
}

export async function getProjectsForUser(
  userId: string,
  role: "ADMIN" | "USER",
  page: number,
  pageSize: number,
): Promise<{
  data: ProjectSummary[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const where = role === "ADMIN" ? {} : { members: { some: { userId } } };

  const [projects, total] = await db.$transaction([
    db.project.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        owner: { select: { id: true, login: true } },
        _count: { select: { members: true } },
      },
    }),
    db.project.count({ where }),
  ]);

  return {
    data: projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      owner: p.owner,
      memberCount: p._count.members,
      createdAt: p.createdAt,
    })),
    total,
    page,
    pageSize,
  };
}

export async function getProjectById(
  id: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<ProjectBoard> {
  // Single query with full include — no N+1 (Constitution XIX)
  const project = await db.project.findUnique({
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
            include: {
              assignee: { select: { id: true, login: true, isActive: true } },
              timeIntervals: { select: { startedAt: true, endedAt: true } },
            },
          },
        },
      },
    },
  });

  if (!project) {
    throw new ApiError("Проект не найден", "NOT_FOUND", 404);
  }

  // Access check: ADMIN sees all, others must be a member
  if (userRole !== "ADMIN") {
    const isMember = project.members.some((m) => m.userId === userId);
    if (!isMember) {
      throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
    }
  }

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    owner: project.owner,
    members: project.members.map((m) => ({
      id: m.user.id,
      login: m.user.login,
      email: m.user.email,
      role: m.role,
    })),
    columns: project.columns.map((col) => ({
      id: col.id,
      name: col.name,
      position: col.position,
      tasks: col.tasks.map((task) => {
        const { totalTimeMs, isInProgress, lastIntervalStartedAt } =
          calcTimeFields(task.timeIntervals);
        return {
          id: task.id,
          columnId: col.id,
          title: task.title,
          description: task.description,
          position: task.position,
          assignee: task.assignee,
          totalTimeMs,
          isInProgress,
          lastIntervalStartedAt,
          createdAt: task.createdAt,
        };
      }),
    })),
  };
}

export async function updateProject(
  id: string,
  data: { name?: string; description?: string | null },
  userId: string,
): Promise<{ id: string; name: string; description: string | null }> {
  const membership = await checkMembership(id, userId);
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец может редактировать проект",
      "FORBIDDEN",
      403,
    );
  }

  return db.project.update({
    where: { id },
    data,
    select: { id: true, name: true, description: true },
  });
}

export async function deleteProject(id: string, userId: string): Promise<void> {
  const membership = await checkMembership(id, userId);
  if (membership !== "OWNER") {
    throw new ApiError(
      "Только владелец может удалить проект",
      "FORBIDDEN",
      403,
    );
  }

  // Cascade delete via Prisma (FK onDelete: Cascade on members, columns, tasks, etc.)
  // Physical file cleanup will be added in Phase 7 (T057) via FileStorage
  await db.project.delete({ where: { id } });
}

export async function addMember(
  projectId: string,
  loginOrEmail: string,
  requesterId: string,
): Promise<{ userId: string; login: string; email: string; role: MemberRole }> {
  const membership = await checkMembership(projectId, requesterId);
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

  const existing = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
  });

  if (existing) {
    throw new ApiError(
      "Пользователь уже является участником",
      "ALREADY_MEMBER",
      409,
    );
  }

  await db.projectMember.create({
    data: { projectId, userId: user.id, role: "MEMBER" },
  });

  // NOTE: notification.service will be integrated in Phase 8 (T064)

  return {
    userId: user.id,
    login: user.login,
    email: user.email,
    role: "MEMBER",
  };
}

// ─── Column service ────────────────────────────────────────────────────────────

export async function createColumn(input: {
  projectId: string;
  name: string;
  requesterId: string;
  requesterRole: "ADMIN" | "USER";
}): Promise<{ id: string; name: string; position: number }> {
  const membership = await checkMembership(input.projectId, input.requesterId);
  if (!membership && input.requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  const maxCol = await db.column.findFirst({
    where: { projectId: input.projectId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = maxCol ? maxCol.position + 1 : 0;

  return db.column.create({
    data: { projectId: input.projectId, name: input.name, position },
    select: { id: true, name: true, position: true },
  });
}

export async function renameColumn(
  columnId: string,
  newName: string,
  requesterId: string,
  requesterRole: "ADMIN" | "USER",
): Promise<{ id: string; name: string }> {
  // Membership check before transaction
  const columnCheck = await db.column.findUnique({
    where: { id: columnId },
    select: { projectId: true },
  });
  if (!columnCheck) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(columnCheck.projectId, requesterId);
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  return db.$transaction(async (tx) => {
    const column = await tx.column.findUnique({
      where: { id: columnId },
    });
    if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

    const oldName = column.name;

    await tx.column.update({
      where: { id: columnId },
      data: { name: newName },
    });

    // Timer logic (delegated to timer.service)
    await handleColumnRename(tx, columnId, oldName, newName);

    return { id: columnId, name: newName };
  });
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

  const membership = await checkMembership(column.projectId, requesterId);
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
    select: { projectId: true },
  });
  if (!column) throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(column.projectId, requesterId);
  if (!membership && requesterRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  await db.column.update({
    where: { id: columnId },
    data: { position: newPosition },
  });

  return { id: columnId, position: newPosition };
}

export async function removeMember(
  projectId: string,
  targetUserId: string,
  requesterId: string,
): Promise<void> {
  const requesterMembership = await checkMembership(projectId, requesterId);
  if (requesterMembership !== "OWNER") {
    throw new ApiError(
      "Только владелец может удалять участников",
      "FORBIDDEN",
      403,
    );
  }

  const targetMembership = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: targetUserId } },
    select: { role: true },
  });

  if (!targetMembership) {
    throw new ApiError("Участник не найден", "MEMBER_NOT_FOUND", 404);
  }

  if (targetMembership.role === "OWNER") {
    throw new ApiError(
      "Нельзя удалить владельца проекта. Сначала передайте права или удалите проект.",
      "CANNOT_REMOVE_OWNER",
      400,
    );
  }

  await db.projectMember.delete({
    where: { projectId_userId: { projectId, userId: targetUserId } },
  });
}
