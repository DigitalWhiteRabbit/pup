import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "./project.service";
import { notify } from "./notification.service";

export type CommentView = {
  id: string;
  text: string;
  author: { id: string; login: string };
  createdAt: Date;
  updatedAt: Date;
};

async function getTaskWithProject(
  taskId: string,
): Promise<{ projectId: string; assigneeIds: string[] }> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      projectId: true,
      assignees: { select: { userId: true } },
    },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);
  return {
    projectId: task.projectId,
    assigneeIds: task.assignees.map((a) => a.userId),
  };
}

export async function createComment(
  input: { taskId: string; authorId: string; text: string },
  userRole: "ADMIN" | "USER",
): Promise<CommentView> {
  const taskInfo = await getTaskWithProject(input.taskId);
  const membership = await checkMembership(taskInfo.projectId, input.authorId);
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
        projectId: taskInfo.projectId,
        extra: { commentText: input.text },
      });
    }
  }

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

  const updated = await db.comment.update({
    where: { id: commentId },
    data: { text: newText },
    select: { id: true, text: true, updatedAt: true },
  });

  return updated;
}

export async function deleteComment(
  commentId: string,
  userId: string,
): Promise<void> {
  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { authorId: true },
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
}
