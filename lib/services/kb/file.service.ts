import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { storage } from "@/lib/services/storage";
import { checkMembership } from "@/lib/services/workspace.service";

export type KbFileView = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedBy: { id: string; login: string } | null;
  uploadedAt: Date;
};

export async function uploadKbFile(input: {
  workspaceId: string;
  file: File;
  uploadedById: string;
  userRole: "ADMIN" | "USER";
}): Promise<KbFileView> {
  const membership = await checkMembership(
    input.workspaceId,
    input.uploadedById,
  );
  if (!membership && input.userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  const arrayBuffer = await input.file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const result = await storage().upload({
    scope: "kb",
    workspaceId: input.workspaceId,
    originalName: input.file.name,
    buffer,
    mimeType: input.file.type || "application/octet-stream",
  });

  const kbFile = await db.kbFile.create({
    data: {
      workspaceId: input.workspaceId,
      uploadedById: input.uploadedById ?? null,
      originalName: input.file.name,
      size: result.size,
      mimeType: result.mimeType,
      storagePath: result.storagePath,
    },
    include: { uploadedBy: { select: { id: true, login: true } } },
  });

  return {
    id: kbFile.id,
    originalName: kbFile.originalName,
    size: kbFile.size,
    mimeType: kbFile.mimeType,
    uploadedBy: kbFile.uploadedBy,
    uploadedAt: kbFile.uploadedAt,
  };
}

export async function listKbFiles(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbFileView[]> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к проекту", "FORBIDDEN", 403);
  }

  const files = await db.kbFile.findMany({
    where: { workspaceId },
    orderBy: { uploadedAt: "desc" },
    include: { uploadedBy: { select: { id: true, login: true } } },
  });

  return files.map((f) => ({
    id: f.id,
    originalName: f.originalName,
    size: f.size,
    mimeType: f.mimeType,
    uploadedBy: f.uploadedBy,
    uploadedAt: f.uploadedAt,
  }));
}

export async function downloadKbFile(
  fileId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<{
  stream: ReadableStream<Uint8Array>;
  originalName: string;
  mimeType: string;
  size: number;
}> {
  const kbFile = await db.kbFile.findUnique({ where: { id: fileId } });
  if (!kbFile) throw new ApiError("Файл не найден", "NOT_FOUND", 404);

  const membership = await checkMembership(kbFile.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к файлу", "FORBIDDEN", 403);
  }

  const stream = await storage().download(kbFile.storagePath);
  return {
    stream,
    originalName: kbFile.originalName,
    mimeType: kbFile.mimeType,
    size: kbFile.size,
  };
}

export async function deleteKbFile(
  fileId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const kbFile = await db.kbFile.findUnique({ where: { id: fileId } });
  if (!kbFile) throw new ApiError("Файл не найден", "NOT_FOUND", 404);

  const membership = await checkMembership(kbFile.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  if (
    kbFile.uploadedById !== userId &&
    membership !== "OWNER" &&
    userRole !== "ADMIN"
  ) {
    throw new ApiError(
      "Удалить файл может только загрузивший или владелец",
      "FORBIDDEN",
      403,
    );
  }

  await storage().delete(kbFile.storagePath);
  await db.kbFile.delete({ where: { id: fileId } });
}
