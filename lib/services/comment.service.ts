import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "./workspace.service";
import { notify } from "./notification.service";
import { logActivity, generateSummary } from "./logger.service";

export type CommentView = {
  id: string;
  text: string;
  author: { id: string; login: string };
  createdAt: Date;
  updatedAt: Date;
};

async function getTaskWithWorkspace(
  taskId: string,
): Promise<{ workspaceId: string; assigneeIds: string[] }> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      workspaceId: true,
      assignees: { select: { userId: true } },
    },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);
  return {
    workspaceId: task.workspaceId,
    assigneeIds: task.assignees.map((a) => a.userId),
  };
}

export async function createComment(
  input: { taskId: string; authorId: string; text: string },
  userRole: "ADMIN" | "USER",
): Promise<CommentView> {
  const taskInfo = await getTaskWithWorkspace(input.taskId);
  const membership = await checkMembership(
    taskInfo.workspaceId,
    input.authorId,
  );
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  const comment = await db.comment.create({
    data: {
      taskId: input.taskId,
      authorId: input.authorId,
      text: input.text,
    },
    include: { author: { select: { id: true, login: true } } },
  });

  for (const uid of taskInfo.assigneeIds) {
    if (uid !== input.authorId) {
      await notify({
        type: "COMMENTED",
        recipientId: uid,
        actorId: input.authorId,
        taskId: input.taskId,
        workspaceId: taskInfo.workspaceId,
        extra: { commentText: input.text },
      });
    }
  }

  const task = await db.task.findUnique({
    where: { id: input.taskId },
    select: { title: true },
  });

  await logActivity({
    workspaceId: taskInfo.workspaceId,
    actorId: input.authorId,
    action: "COMMENT_CREATED",
    entityType: "Comment",
    entityId: comment.id,
    taskId: input.taskId,
    summary: generateSummary("COMMENT_CREATED", {
      actorLogin: comment.author.login,
      taskTitle: task?.title,
    }),
    metadata: { taskId: input.taskId, commentId: comment.id },
  });

  return {
    id: comment.id,
    text: comment.text,
    author: comment.author,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

export async function updateComment(
  commentId: string,
  newText: string,
  userId: string,
): Promise<{ id: string; text: string; updatedAt: Date }> {
  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { authorId: true },
  });
  if (!comment) throw new ApiError("Комментарий не найден", "NOT_FOUND", 404);
  if (comment.authorId !== userId) {
    throw new ApiError(
      "Только автор может редактировать комментарий",
      "FORBIDDEN",
      403,
    );
  }

  const commentFull = await db.comment.findUnique({
    where: { id: commentId },
    select: {
      taskId: true,
      task: { select: { workspaceId: true, title: true } },
      author: { select: { login: true } },
    },
  });

  const updated = await db.comment.update({
    where: { id: commentId },
    data: { text: newText },
    select: { id: true, text: true, updatedAt: true },
  });

  if (commentFull) {
    await logActivity({
      workspaceId: commentFull.task.workspaceId,
      actorId: userId,
      action: "COMMENT_UPDATED",
      entityType: "Comment",
      entityId: commentId,
      taskId: commentFull.taskId,
      summary: generateSummary("COMMENT_UPDATED", {
        actorLogin: commentFull.author.login,
        taskTitle: commentFull.task.title,
      }),
      metadata: { taskId: commentFull.taskId, commentId },
    });
  }

  return updated;
}

export async function deleteComment(
  commentId: string,
  userId: string,
): Promise<void> {
  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: {
      authorId: true,
      taskId: true,
      task: { select: { workspaceId: true, title: true } },
      author: { select: { login: true } },
    },
  });
  if (!comment) throw new ApiError("Комментарий не найден", "NOT_FOUND", 404);
  if (comment.authorId !== userId) {
    throw new ApiError(
      "Только автор может удалить комментарий",
      "FORBIDDEN",
      403,
    );
  }

  await db.comment.delete({ where: { id: commentId } });

  await logActivity({
    workspaceId: comment.task.workspaceId,
    actorId: userId,
    action: "COMMENT_DELETED",
    entityType: "Comment",
    entityId: commentId,
    taskId: comment.taskId,
    summary: generateSummary("COMMENT_DELETED", {
      actorLogin: comment.author.login,
      taskTitle: comment.task.title,
    }),
    metadata: { taskId: comment.taskId, commentId },
  });
}
