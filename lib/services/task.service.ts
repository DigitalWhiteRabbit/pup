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

// ─── Types ────────────────────────────────────────────────────────────────────

export type TaskSummary = {
  id: string;
  projectId: string;
  columnId: string;
  title: string;
  description: string | null;
  position: number;
  assignee: { id: string; login: string; isActive: boolean } | null;
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

// ─── createTask ───────────────────────────────────────────────────────────────

export async function createTask(
  input: {
    title: string;
    description?: string | null;
    columnId: string;
    assigneeId?: string | null;
    projectId: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TaskSummary> {
  // Membership check outside transaction (read-only)
  const membership = await checkMembership(input.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  // All reads + write in one transaction to avoid race condition on position
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
        columnId: input.columnId,
        projectId: input.projectId,
        assigneeId: input.assigneeId ?? null,
        position,
      },
      include: {
        assignee: { select: { id: true, login: true, isActive: true } },
      },
    });

    if (willBeInProgress) {
      await openInterval(tx, created.id);
    }

    return { task: created, willBeInProgress };
  });

  if (task.task.assigneeId && task.task.assigneeId !== userId) {
    await notify({
      type: "ASSIGNED",
      recipientId: task.task.assigneeId,
      actorId: userId,
      taskId: task.task.id,
      projectId: task.task.projectId,
    });
  }

  const now = new Date();
  return {
    id: task.task.id,
    projectId: task.task.projectId,
    columnId: task.task.columnId,
    title: task.task.title,
    description: task.task.description,
    position: task.task.position,
    assignee: task.task.assignee,
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
    assigneeId?: string | null;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TaskSummary> {
  const task = await db.task.findUnique({
    where: { id },
    select: { projectId: true, assigneeId: true },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.projectId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const oldAssigneeId = task.assigneeId;

  const updated = await db.task.update({
    where: { id },
    data,
    include: {
      assignee: { select: { id: true, login: true, isActive: true } },
      timeIntervals: { select: { startedAt: true, endedAt: true } },
    },
  });

  if (
    data.assigneeId &&
    data.assigneeId !== oldAssigneeId &&
    data.assigneeId !== userId
  ) {
    await notify({
      type: "ASSIGNED",
      recipientId: data.assigneeId,
      actorId: userId,
      taskId: id,
      projectId: task.projectId,
    });
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
    position: updated.position,
    assignee: updated.assignee,
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

  // Cascade: TimeInterval, ColumnMoveLog, Comment, Attachment deleted by Prisma schema
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
  // Membership check before transaction (read-only, no need to be atomic)
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
    // 1. Get task with source column
    const task = await tx.task.findUnique({
      where: { id: taskId },
      include: { column: { select: { name: true, projectId: true } } },
    });
    if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

    // 2. Get target column
    const targetColumn = await tx.column.findUnique({
      where: { id: targetColumnId },
      select: { name: true, projectId: true },
    });
    if (!targetColumn) {
      throw new ApiError("Целевая колонка не найдена", "NOT_FOUND", 404);
    }

    // 3. Same project check (no cross-project moves)
    if (targetColumn.projectId !== task.column.projectId) {
      throw new ApiError(
        "Нельзя перемещать задачи между проектами",
        "CROSS_PROJECT",
        400,
      );
    }

    const columnChanged = task.columnId !== targetColumnId;

    // 4. Update task position and column
    await tx.task.update({
      where: { id: taskId },
      data: { columnId: targetColumnId, position: targetPosition },
    });

    // 5. Log move only when column actually changes
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

    // 6. Timer logic (delegated to timer.service)
    await handleColumnTransition(
      tx,
      taskId,
      task.column.name,
      targetColumn.name,
    );

    // 7. Calculate updated totals
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
      _assigneeId: task.assigneeId,
      _projectId: task.column.projectId,
    };
  });

  // Notify MOVED after transaction (fire-and-forget Telegram inside notify)
  if (result._assigneeId && result._assigneeId !== userId) {
    await notify({
      type: "MOVED",
      recipientId: result._assigneeId,
      actorId: userId,
      taskId,
      projectId: result._projectId,
    });
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
      assignee: { select: { id: true, login: true, isActive: true } },
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
    position: task.position,
    assignee: task.assignee,
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
