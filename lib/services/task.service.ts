import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "./project.service";
import { isWorkColumn } from "@/lib/utils/columns";
import {
  openInterval,
  handleColumnTransition,
  calcTimeFields,
} from "./timer.service";
import { notify } from "./notification.service";
import type { TaskPriority } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

type Assignee = { id: string; login: string; isActive: boolean };

export type TaskSummary = {
  id: string;
  projectId: string;
  columnId: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  position: number;
  assignees: Assignee[];
  totalTimeMs: number;
  isInProgress: boolean;
  lastIntervalStartedAt: Date | null;
  createdAt: Date;
};

export type TaskFull = TaskSummary & {
  columnName: string;
  comments: Array<{
    id: string;
    text: string;
    author: { id: string; login: string };
    createdAt: Date;
    updatedAt: Date;
  }>;
  attachments: Array<{
    id: string;
    originalName: string;
    size: number;
    mimeType: string;
    uploadedBy: { id: string; login: string };
    uploadedAt: Date;
  }>;
  moveHistory: Array<{
    fromColumnName: string;
    toColumnName: string;
    movedBy: { id: string; login: string };
    movedAt: Date;
  }>;
};

const assigneeSelect = {
  user: { select: { id: true, login: true, isActive: true } },
} as const;

function mapAssignees(assignees: Array<{ user: Assignee }>): Assignee[] {
  return assignees.map((a) => a.user);
}

// ─── createTask ───────────────────────────────────────────────────────────────

export async function createTask(
  input: {
    title: string;
    description?: string | null;
    columnId: string;
    assigneeIds?: string[];
    priority?: TaskPriority;
    projectId: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TaskSummary> {
  const membership = await checkMembership(input.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  const assigneeIds = input.assigneeIds ?? [];

  const task = await db.$transaction(async (tx) => {
    const column = await tx.column.findUnique({
      where: { id: input.columnId },
      select: { projectId: true, name: true },
    });
    if (!column || column.projectId !== input.projectId) {
      throw new ApiError("Колонка не найдена", "NOT_FOUND", 404);
    }

    const maxPositionTask = await tx.task.findFirst({
      where: { columnId: input.columnId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const position = maxPositionTask ? maxPositionTask.position + 1 : 0;

    const willBeInProgress = isWorkColumn(column.name);

    const created = await tx.task.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? "NONE",
        columnId: input.columnId,
        projectId: input.projectId,
        position,
        assignees:
          assigneeIds.length > 0
            ? { create: assigneeIds.map((uid) => ({ userId: uid })) }
            : undefined,
      },
      include: { assignees: { include: assigneeSelect } },
    });

    if (willBeInProgress) {
      await openInterval(tx, created.id);
    }

    return { task: created, willBeInProgress };
  });

  // Notify new assignees (except self)
  for (const uid of assigneeIds) {
    if (uid !== userId) {
      await notify({
        type: "ASSIGNED",
        recipientId: uid,
        actorId: userId,
        taskId: task.task.id,
        projectId: task.task.projectId,
      });
    }
  }

  const now = new Date();
  return {
    id: task.task.id,
    projectId: task.task.projectId,
    columnId: task.task.columnId,
    title: task.task.title,
    description: task.task.description,
    priority: task.task.priority,
    position: task.task.position,
    assignees: mapAssignees(task.task.assignees),
    totalTimeMs: 0,
    isInProgress: task.willBeInProgress,
    lastIntervalStartedAt: task.willBeInProgress ? now : null,
    createdAt: task.task.createdAt,
  };
}

// ─── updateTask ───────────────────────────────────────────────────────────────

export async function updateTask(
  id: string,
  data: {
    title?: string;
    description?: string | null;
    assigneeIds?: string[];
    priority?: TaskPriority;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TaskSummary> {
  const task = await db.task.findUnique({
    where: { id },
    select: {
      projectId: true,
      assignees: { select: { userId: true } },
    },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const oldAssigneeIds = new Set(task.assignees.map((a) => a.userId));

  const updated = await db.$transaction(async (tx) => {
    // Update assignees if provided
    if (data.assigneeIds !== undefined) {
      // Delete all current, re-create
      await tx.taskAssignee.deleteMany({ where: { taskId: id } });
      if (data.assigneeIds.length > 0) {
        await tx.taskAssignee.createMany({
          data: data.assigneeIds.map((uid) => ({ taskId: id, userId: uid })),
        });
      }
    }

    return tx.task.update({
      where: { id },
      data: {
        title: data.title,
        description: data.description,
        priority: data.priority,
      },
      include: {
        assignees: { include: assigneeSelect },
        timeIntervals: { select: { startedAt: true, endedAt: true } },
      },
    });
  });

  // Notify newly added assignees
  if (data.assigneeIds !== undefined) {
    for (const uid of data.assigneeIds) {
      if (!oldAssigneeIds.has(uid) && uid !== userId) {
        await notify({
          type: "ASSIGNED",
          recipientId: uid,
          actorId: userId,
          taskId: id,
          projectId: task.projectId,
        });
      }
    }
  }

  const { totalTimeMs, isInProgress, lastIntervalStartedAt } = calcTimeFields(
    updated.timeIntervals,
  );

  return {
    id: updated.id,
    projectId: updated.projectId,
    columnId: updated.columnId,
    title: updated.title,
    description: updated.description,
    priority: updated.priority,
    position: updated.position,
    assignees: mapAssignees(updated.assignees),
    totalTimeMs,
    isInProgress,
    lastIntervalStartedAt,
    createdAt: updated.createdAt,
  };
}

// ─── deleteTask ───────────────────────────────────────────────────────────────

export async function deleteTask(
  id: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const task = await db.task.findUnique({
    where: { id },
    select: { projectId: true },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  await db.task.delete({ where: { id } });
}

// ─── moveTask ─────────────────────────────────────────────────────────────────

export async function moveTask(
  taskId: string,
  targetColumnId: string,
  targetPosition: number,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<{
  taskId: string;
  columnId: string;
  position: number;
  totalTimeMs: number;
  isInProgress: boolean;
  lastIntervalStartedAt: Date | null;
}> {
  const taskCheck = await db.task.findUnique({
    where: { id: taskId },
    select: { column: { select: { projectId: true } } },
  });
  if (!taskCheck) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(taskCheck.column.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const result = await db.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      include: {
        column: { select: { name: true, projectId: true } },
        assignees: { select: { userId: true } },
      },
    });
    if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

    const targetColumn = await tx.column.findUnique({
      where: { id: targetColumnId },
      select: { name: true, projectId: true },
    });
    if (!targetColumn) {
      throw new ApiError("Целевая колонка не найдена", "NOT_FOUND", 404);
    }

    if (targetColumn.projectId !== task.column.projectId) {
      throw new ApiError(
        "Нельзя перемещать задачи между проектами",
        "CROSS_PROJECT",
        400,
      );
    }

    const columnChanged = task.columnId !== targetColumnId;

    await tx.task.update({
      where: { id: taskId },
      data: { columnId: targetColumnId, position: targetPosition },
    });

    if (columnChanged) {
      await tx.columnMoveLog.create({
        data: {
          taskId,
          movedByUserId: userId,
          fromColumnName: task.column.name,
          toColumnName: targetColumn.name,
        },
      });
    }

    await handleColumnTransition(
      tx,
      taskId,
      task.column.name,
      targetColumn.name,
    );

    const intervals = await tx.timeInterval.findMany({
      where: { taskId },
      select: { startedAt: true, endedAt: true },
    });

    const { totalTimeMs, isInProgress, lastIntervalStartedAt } =
      calcTimeFields(intervals);

    return {
      taskId,
      columnId: targetColumnId,
      position: targetPosition,
      totalTimeMs,
      isInProgress,
      lastIntervalStartedAt,
      _assigneeIds: task.assignees.map((a) => a.userId),
      _projectId: task.column.projectId,
    };
  });

  // Notify all assignees about the move
  for (const uid of result._assigneeIds) {
    if (uid !== userId) {
      await notify({
        type: "MOVED",
        recipientId: uid,
        actorId: userId,
        taskId,
        projectId: result._projectId,
      });
    }
  }

  return {
    taskId: result.taskId,
    columnId: result.columnId,
    position: result.position,
    totalTimeMs: result.totalTimeMs,
    isInProgress: result.isInProgress,
    lastIntervalStartedAt: result.lastIntervalStartedAt,
  };
}

// ─── reorderTask ──────────────────────────────────────────────────────────────

export async function reorderTask(
  taskId: string,
  newPosition: number,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<{ taskId: string; position: number }> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { projectId: true },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  await db.task.update({
    where: { id: taskId },
    data: { position: newPosition },
  });

  return { taskId, position: newPosition };
}

// ─── getTaskById ──────────────────────────────────────────────────────────────

export async function getTaskById(
  id: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TaskFull> {
  const task = await db.task.findUnique({
    where: { id },
    include: {
      column: { select: { name: true } },
      assignees: { include: assigneeSelect },
      timeIntervals: { select: { startedAt: true, endedAt: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { author: { select: { id: true, login: true } } },
      },
      attachments: {
        orderBy: { uploadedAt: "asc" },
        include: { uploadedBy: { select: { id: true, login: true } } },
      },
      moveLogs: {
        orderBy: { movedAt: "asc" },
        include: { movedBy: { select: { id: true, login: true } } },
      },
    },
  });

  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const { totalTimeMs, isInProgress, lastIntervalStartedAt } = calcTimeFields(
    task.timeIntervals,
  );

  return {
    id: task.id,
    projectId: task.projectId,
    columnId: task.columnId,
    columnName: task.column.name,
    title: task.title,
    description: task.description,
    priority: task.priority,
    position: task.position,
    assignees: mapAssignees(task.assignees),
    totalTimeMs,
    isInProgress,
    lastIntervalStartedAt,
    createdAt: task.createdAt,
    comments: task.comments.map((c) => ({
      id: c.id,
      text: c.text,
      author: c.author,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    attachments: task.attachments.map((a) => ({
      id: a.id,
      originalName: a.originalName,
      size: a.size,
      mimeType: a.mimeType,
      uploadedBy: a.uploadedBy,
      uploadedAt: a.uploadedAt,
    })),
    moveHistory: task.moveLogs.map((log) => ({
      fromColumnName: log.fromColumnName,
      toColumnName: log.toColumnName,
      movedBy: log.movedBy,
      movedAt: log.movedAt,
    })),
  };
}
