import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "./workspace.service";
import { isWorkColumn } from "@/lib/utils/columns";
import {
  openInterval,
  handleColumnTransition,
  calcTimeFields,
} from "./timer.service";
import { notify } from "./notification.service";
import {
  logActivity,
  notifyCriticalEvent,
  generateSummary,
} from "./logger.service";
import type { TaskPriority } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

type Assignee = { id: string; login: string; isActive: boolean };

export type LabelView = { id: string; name: string; color: string };
export type ChecklistItemView = {
  id: string;
  text: string;
  checked: boolean;
  position: number;
};

export type TaskSummary = {
  id: string;
  workspaceId: string;
  columnId: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  position: number;
  startDate: Date | null;
  dueDate: Date | null;
  assignees: Assignee[];
  labels: LabelView[];
  checklistTotal: number;
  checklistDone: number;
  totalTimeMs: number;
  isInProgress: boolean;
  lastIntervalStartedAt: Date | null;
  createdAt: Date;
};

export type TaskFull = TaskSummary & {
  columnName: string;
  createdBy: { id: string; login: string } | null;
  checklistItems: ChecklistItemView[];
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
    workspaceId: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TaskSummary> {
  const membership = await checkMembership(input.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  const assigneeIds = input.assigneeIds ?? [];

  const task = await db.$transaction(async (tx) => {
    const column = await tx.column.findUnique({
      where: { id: input.columnId },
      select: { workspaceId: true, name: true },
    });
    if (!column || column.workspaceId !== input.workspaceId) {
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
        workspaceId: input.workspaceId,
        position,
        createdById: userId,
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
        workspaceId: task.task.workspaceId,
      });
    }
  }

  const actor = await db.user.findUnique({
    where: { id: userId },
    select: { login: true },
  });

  const columnForLog = await db.column.findUnique({
    where: { id: input.columnId },
    select: { name: true },
  });

  await logActivity({
    workspaceId: input.workspaceId,
    actorId: userId,
    action: "TASK_CREATED",
    entityType: "Task",
    entityId: task.task.id,
    taskId: task.task.id,
    columnId: input.columnId,
    summary: generateSummary("TASK_CREATED", {
      actorLogin: actor?.login,
      taskTitle: task.task.title,
    }),
    metadata: {
      columnId: input.columnId,
      columnName: columnForLog?.name,
      assignees: assigneeIds,
    },
  });

  const now = new Date();
  return {
    id: task.task.id,
    workspaceId: task.task.workspaceId,
    columnId: task.task.columnId,
    title: task.task.title,
    description: task.task.description,
    priority: task.task.priority,
    position: task.task.position,
    startDate: task.task.startDate,
    dueDate: task.task.dueDate,
    assignees: mapAssignees(task.task.assignees),
    labels: [],
    checklistTotal: 0,
    checklistDone: 0,
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
    startDate?: string | null;
    dueDate?: string | null;
    labelIds?: string[];
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TaskSummary> {
  const task = await db.task.findUnique({
    where: { id },
    select: {
      workspaceId: true,
      title: true,
      priority: true,
      dueDate: true,
      startDate: true,
      assignees: { select: { userId: true } },
    },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const oldAssigneeIds = new Set(task.assignees.map((a) => a.userId));

  const updated = await db.$transaction(async (tx) => {
    if (data.assigneeIds !== undefined) {
      await tx.taskAssignee.deleteMany({ where: { taskId: id } });
      if (data.assigneeIds.length > 0) {
        await tx.taskAssignee.createMany({
          data: data.assigneeIds.map((uid) => ({ taskId: id, userId: uid })),
        });
      }
    }

    if (data.labelIds !== undefined) {
      await tx.taskLabel.deleteMany({ where: { taskId: id } });
      if (data.labelIds.length > 0) {
        await tx.taskLabel.createMany({
          data: data.labelIds.map((lid) => ({ taskId: id, labelId: lid })),
        });
      }
    }

    return tx.task.update({
      where: { id },
      data: {
        title: data.title,
        description: data.description,
        priority: data.priority,
        startDate:
          data.startDate !== undefined
            ? data.startDate
              ? new Date(data.startDate)
              : null
            : undefined,
        dueDate:
          data.dueDate !== undefined
            ? data.dueDate
              ? new Date(data.dueDate)
              : null
            : undefined,
      },
      include: {
        assignees: { include: assigneeSelect },
        labels: { include: { label: true } },
        checklistItems: { orderBy: { position: "asc" } },
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
          workspaceId: task.workspaceId,
        });
      }
    }
  }

  // Emit fine-grained activity logs for each changed field
  const actor = await db.user.findUnique({
    where: { id: userId },
    select: { login: true },
  });
  const actorLogin = actor?.login;

  if (data.title !== undefined && data.title !== task.title) {
    await logActivity({
      workspaceId: task.workspaceId,
      actorId: userId,
      action: "TASK_UPDATED",
      entityType: "Task",
      entityId: id,
      taskId: id,
      summary: generateSummary("TASK_UPDATED", {
        actorLogin,
        taskTitle: data.title,
        taskTitleOld: task.title,
      }),
      metadata: { oldTitle: task.title, newTitle: data.title },
    });
  }

  if (data.priority !== undefined && data.priority !== task.priority) {
    await logActivity({
      workspaceId: task.workspaceId,
      actorId: userId,
      action: "TASK_PRIORITY_CHANGED",
      entityType: "Task",
      entityId: id,
      taskId: id,
      summary: generateSummary("TASK_PRIORITY_CHANGED", {
        actorLogin,
        taskTitle: updated.title,
        priorityOld: task.priority,
        priority: data.priority,
      }),
      metadata: { oldPriority: task.priority, newPriority: data.priority },
    });
  }

  const newDueDate = data.dueDate !== undefined ? data.dueDate : undefined;
  const newStartDate =
    data.startDate !== undefined ? data.startDate : undefined;
  if (newDueDate !== undefined || newStartDate !== undefined) {
    const oldDue = task.dueDate?.toISOString() ?? null;
    const oldStart = task.startDate?.toISOString() ?? null;
    const changedDue = newDueDate !== undefined && newDueDate !== oldDue;
    const changedStart =
      newStartDate !== undefined && newStartDate !== oldStart;
    if (changedDue || changedStart) {
      await logActivity({
        workspaceId: task.workspaceId,
        actorId: userId,
        action: "TASK_DATE_CHANGED",
        entityType: "Task",
        entityId: id,
        taskId: id,
        summary: generateSummary("TASK_DATE_CHANGED", {
          actorLogin,
          taskTitle: updated.title,
        }),
        metadata: {
          oldDueDate: oldDue,
          newDueDate: newDueDate ?? null,
          oldStartDate: oldStart,
          newStartDate: newStartDate ?? null,
        },
      });
    }
  }

  if (data.assigneeIds !== undefined) {
    const newIds = new Set(data.assigneeIds);
    const addedIds = data.assigneeIds.filter((uid) => !oldAssigneeIds.has(uid));
    const removedIds = Array.from(oldAssigneeIds).filter(
      (uid) => !newIds.has(uid),
    );

    // Batch-load all affected assignee logins in one query
    const allAffectedIds = [...addedIds, ...removedIds];
    const assigneeUsers =
      allAffectedIds.length > 0
        ? await db.user.findMany({
            where: { id: { in: allAffectedIds } },
            select: { id: true, login: true },
          })
        : [];
    const assigneeLoginMap = new Map(assigneeUsers.map((u) => [u.id, u.login]));

    for (const uid of addedIds) {
      const assigneeLogin = assigneeLoginMap.get(uid);
      await logActivity({
        workspaceId: task.workspaceId,
        actorId: userId,
        action: "TASK_ASSIGNEE_ADDED",
        entityType: "Task",
        entityId: id,
        taskId: id,
        summary: generateSummary("TASK_ASSIGNEE_ADDED", {
          actorLogin,
          taskTitle: updated.title,
          targetLogin: assigneeLogin,
        }),
        metadata: { assigneeId: uid, assigneeLogin },
      });
    }

    for (const uid of removedIds) {
      const assigneeLogin = assigneeLoginMap.get(uid);
      await logActivity({
        workspaceId: task.workspaceId,
        actorId: userId,
        action: "TASK_ASSIGNEE_REMOVED",
        entityType: "Task",
        entityId: id,
        taskId: id,
        summary: generateSummary("TASK_ASSIGNEE_REMOVED", {
          actorLogin,
          taskTitle: updated.title,
          targetLogin: assigneeLogin,
        }),
        metadata: { assigneeId: uid, assigneeLogin },
      });
    }
  }

  const { totalTimeMs, isInProgress, lastIntervalStartedAt } = calcTimeFields(
    updated.timeIntervals,
  );

  return {
    id: updated.id,
    workspaceId: updated.workspaceId,
    columnId: updated.columnId,
    title: updated.title,
    description: updated.description,
    priority: updated.priority,
    position: updated.position,
    startDate: updated.startDate,
    dueDate: updated.dueDate,
    assignees: mapAssignees(updated.assignees),
    labels: updated.labels.map((tl) => tl.label),
    checklistTotal: updated.checklistItems.length,
    checklistDone: updated.checklistItems.filter((i) => i.checked).length,
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
    select: {
      workspaceId: true,
      title: true,
      column: { select: { name: true } },
    },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const [actor, workspace] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { login: true } }),
    db.workspace.findUnique({
      where: { id: task.workspaceId },
      select: { name: true },
    }),
  ]);

  await db.task.delete({ where: { id } });

  await logActivity({
    workspaceId: task.workspaceId,
    actorId: userId,
    action: "TASK_DELETED",
    entityType: "Task",
    entityId: id,
    summary: generateSummary("TASK_DELETED", {
      actorLogin: actor?.login,
      taskTitle: task.title,
    }),
    metadata: { taskTitle: task.title, columnName: task.column.name },
  });

  void notifyCriticalEvent({
    action: "TASK_DELETED",
    workspaceId: task.workspaceId,
    workspaceName: workspace?.name ?? "?",
    taskTitle: task.title,
    actorLogin: actor?.login ?? userId,
  });
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
    select: { column: { select: { workspaceId: true } } },
  });
  if (!taskCheck) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(
    taskCheck.column.workspaceId,
    userId,
  );
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const result = await db.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      include: {
        column: { select: { name: true, workspaceId: true } },
        assignees: { select: { userId: true } },
      },
    });
    if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);
    const taskTitle = task.title;

    const targetColumn = await tx.column.findUnique({
      where: { id: targetColumnId },
      select: { name: true, workspaceId: true },
    });
    if (!targetColumn) {
      throw new ApiError("Целевая колонка не найдена", "NOT_FOUND", 404);
    }

    if (targetColumn.workspaceId !== task.column.workspaceId) {
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
      _workspaceId: task.column.workspaceId,
      _fromColumn: task.column.name,
      _toColumn: targetColumn.name,
      _taskTitle: taskTitle,
      _columnChanged: columnChanged,
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
        workspaceId: result._workspaceId,
        extra: {
          fromColumn: result._fromColumn,
          toColumn: result._toColumn,
        },
      });
    }
  }

  if (result._columnChanged) {
    const actor = await db.user.findUnique({
      where: { id: userId },
      select: { login: true },
    });

    await logActivity({
      workspaceId: result._workspaceId,
      actorId: userId,
      action: "TASK_MOVED",
      entityType: "Task",
      entityId: taskId,
      taskId,
      columnId: targetColumnId,
      summary: generateSummary("TASK_MOVED", {
        actorLogin: actor?.login,
        taskTitle: result._taskTitle,
        columnNameOld: result._fromColumn,
        columnName: result._toColumn,
      }),
      metadata: {
        fromColumn: result._fromColumn,
        toColumn: result._toColumn,
      },
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
    select: { workspaceId: true },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

  const membership = await checkMembership(task.workspaceId, userId);
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
      createdBy: { select: { id: true, login: true } },
      assignees: { include: assigneeSelect },
      labels: { include: { label: true } },
      checklistItems: { orderBy: { position: "asc" } },
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

  const membership = await checkMembership(task.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const { totalTimeMs, isInProgress, lastIntervalStartedAt } = calcTimeFields(
    task.timeIntervals,
  );

  return {
    id: task.id,
    workspaceId: task.workspaceId,
    columnId: task.columnId,
    columnName: task.column.name,
    title: task.title,
    description: task.description,
    priority: task.priority,
    position: task.position,
    startDate: task.startDate,
    dueDate: task.dueDate,
    assignees: mapAssignees(task.assignees),
    labels: task.labels.map((tl) => tl.label),
    checklistTotal: task.checklistItems.length,
    checklistDone: task.checklistItems.filter((i) => i.checked).length,
    checklistItems: task.checklistItems.map((i) => ({
      id: i.id,
      text: i.text,
      checked: i.checked,
      position: i.position,
    })),
    totalTimeMs,
    isInProgress,
    lastIntervalStartedAt,
    createdAt: task.createdAt,
    createdBy: task.createdBy,
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
