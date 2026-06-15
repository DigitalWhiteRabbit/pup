import "server-only";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { storage } from "@/lib/services/storage";
import { checkMembership } from "@/lib/services/workspace.service";
import { queueFileIndex } from "./index.service";

export type KbFileView = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedBy: { id: string; login: string } | null;
  uploadedAt: Date;
  hasExtractedText: boolean;
  extractionError: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUploadDir(): string {
  return path.resolve(process.env["UPLOAD_DIR"] ?? "./uploads");
}

function resolveStoragePath(storagePath: string): string {
  const uploadDir = getUploadDir();
  const resolved = path.resolve(path.join(uploadDir, storagePath));
  if (!resolved.startsWith(uploadDir + path.sep) && resolved !== uploadDir) {
    throw new ApiError("Invalid file path", "INVALID_PATH", 400);
  }
  return resolved;
}

// ─── Text Extraction ──────────────────────────────────────────────────────────

/**
 * Extract text content from uploaded document (PDF, DOCX, XLSX, TXT, MD, etc.)
 * Runs in background after upload -- does not block the upload response.
 */
async function extractFileText(
  fileId: string,
  storagePath: string,
  mimeType: string,
  originalName: string,
): Promise<void> {
  try {
    const filePath = resolveStoragePath(storagePath);
    const buffer = await fs.readFile(filePath);

    const { parseDocument } = await import("./parsers");
    const result = await parseDocument(buffer, mimeType, originalName);

    const updated = await db.kbFile.update({
      where: { id: fileId },
      data: {
        extractedText: result.content,
        extractedAt: new Date(),
        extractionError: null,
      },
      select: { workspaceId: true },
    });

    // KB-vector: index the extracted text in the background.
    queueFileIndex(updated.workspaceId, {
      id: fileId,
      extractedText: result.content,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown extraction error";
    await db.kbFile.update({
      where: { id: fileId },
      data: {
        extractionError: message,
        extractedAt: new Date(),
      },
    });
  }
}

/**
 * On-demand extraction for files that weren't extracted at upload time.
 * Returns the extracted text or null if extraction fails.
 */
export async function extractFileTextOnDemand(fileId: string): Promise<{
  content: string | null;
  extractedAt: Date | null;
  error: string | null;
}> {
  const kbFile = await db.kbFile.findUnique({ where: { id: fileId } });
  if (!kbFile) throw new ApiError("File not found", "NOT_FOUND", 404);

  // Already extracted successfully
  if (kbFile.extractedText && kbFile.extractedAt) {
    return {
      content: kbFile.extractedText,
      extractedAt: kbFile.extractedAt,
      error: null,
    };
  }

  // Previous extraction failed -- return the error
  if (kbFile.extractionError && kbFile.extractedAt) {
    return {
      content: null,
      extractedAt: kbFile.extractedAt,
      error: kbFile.extractionError,
    };
  }

  // Not yet extracted -- try now
  await extractFileText(
    fileId,
    kbFile.storagePath,
    kbFile.mimeType,
    kbFile.originalName,
  );

  const updated = await db.kbFile.findUnique({ where: { id: fileId } });
  return {
    content: updated?.extractedText ?? null,
    extractedAt: updated?.extractedAt ?? null,
    error: updated?.extractionError ?? null,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

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

  // Auto-extract text in background (don't block upload response)
  void extractFileText(
    kbFile.id,
    kbFile.storagePath,
    kbFile.mimeType,
    kbFile.originalName,
  ).catch(() => {});

  return {
    id: kbFile.id,
    originalName: kbFile.originalName,
    size: kbFile.size,
    mimeType: kbFile.mimeType,
    uploadedBy: kbFile.uploadedBy,
    uploadedAt: kbFile.uploadedAt,
    hasExtractedText: false,
    extractionError: null,
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
    hasExtractedText: !!f.extractedText,
    extractionError: f.extractionError,
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
