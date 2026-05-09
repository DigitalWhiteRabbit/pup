import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { storage } from "./storage";
import { checkMembership } from "./workspace.service";

export type AttachmentView = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedBy: { id: string; login: string };
  uploadedAt: Date;
};

export type DownloadResult = {
  stream: ReadableStream<Uint8Array>;
  originalName: string;
  mimeType: string;
  size: number;
};

async function getTaskWorkspaceId(taskId: string): Promise<string> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { workspaceId: true },
  });
  if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);
  return task.workspaceId;
}

export async function uploadAttachment(
  input: { taskId: string; file: File; uploadedById: string },
  userRole: "ADMIN" | "USER",
): Promise<AttachmentView> {
  const workspaceId = await getTaskWorkspaceId(input.taskId);
  const membership = await checkMembership(workspaceId, input.uploadedById);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  const arrayBuffer = await input.file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const result = await storage().upload({
    projectId: workspaceId,
    taskId: input.taskId,
    originalName: input.file.name,
    buffer,
    mimeType: input.file.type || "application/octet-stream",
  });

  const attachment = await db.attachment.create({
    data: {
      taskId: input.taskId,
      uploadedById: input.uploadedById,
      originalName: input.file.name,
      size: result.size,
      mimeType: result.mimeType,
      storagePath: result.storagePath,
    },
    include: { uploadedBy: { select: { id: true, login: true } } },
  });

  return {
    id: attachment.id,
    originalName: attachment.originalName,
    size: attachment.size,
    mimeType: attachment.mimeType,
    uploadedBy: attachment.uploadedBy,
    uploadedAt: attachment.uploadedAt,
  };
}

export async function downloadAttachment(
  attachmentId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<DownloadResult> {
  const attachment = await db.attachment.findUnique({
    where: { id: attachmentId },
    include: { task: { select: { workspaceId: true } } },
  });
  if (!attachment) {
    throw new ApiError("Вложение не найдено", "NOT_FOUND", 404);
  }

  const membership = await checkMembership(attachment.task.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к файлу", "FORBIDDEN", 403);
  }

  const stream = await storage().download(attachment.storagePath);

  return {
    stream,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

export async function deleteAttachment(
  attachmentId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const attachment = await db.attachment.findUnique({
    where: { id: attachmentId },
    include: { task: { select: { workspaceId: true } } },
  });
  if (!attachment) {
    throw new ApiError("Вложение не найдено", "NOT_FOUND", 404);
  }

  const membership = await checkMembership(attachment.task.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  // Only uploader or OWNER can delete
  if (attachment.uploadedById !== userId && membership !== "OWNER") {
    throw new ApiError(
      "Удалить вложение может только загрузивший или владелец проекта",
      "FORBIDDEN",
      403,
    );
  }

  await storage().delete(attachment.storagePath);
  await db.attachment.delete({ where: { id: attachmentId } });
}
