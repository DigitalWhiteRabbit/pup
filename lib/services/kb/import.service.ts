import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import { storage } from "@/lib/services/storage";
import { parseDocument } from "./parsers";
import { parseUrl } from "./url-parser.service";
import { createArticle, type KbArticleSummary } from "./article.service";

// ─── importFromFile ───────────────────────────────────────────────────────────

export async function importFromFile(
  input: {
    workspaceId: string;
    file: File;
    categoryId?: string;
    tagIds?: string[];
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbArticleSummary> {
  const membership = await checkMembership(input.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const arrayBuffer = await input.file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = input.file.type || "application/octet-stream";

  // Upload file to KB storage
  const storageResult = await storage().upload({
    scope: "kb",
    workspaceId: input.workspaceId,
    originalName: input.file.name,
    buffer,
    mimeType,
  });

  // Create KbFile record
  const kbFile = await db.kbFile.create({
    data: {
      workspaceId: input.workspaceId,
      uploadedById: userId,
      originalName: input.file.name,
      size: storageResult.size,
      mimeType: storageResult.mimeType,
      storagePath: storageResult.storagePath,
    },
  });

  void logActivity({
    workspaceId: input.workspaceId,
    actorId: userId,
    action: "KB_FILE_UPLOADED",
    entityType: "KbFile",
    entityId: kbFile.id,
    summary: generateSummary("KB_FILE_UPLOADED", {
      attachmentName: input.file.name,
    }),
    metadata: { fileName: input.file.name, size: storageResult.size },
  });

  // Parse document
  const parsed = await parseDocument(buffer, mimeType, input.file.name);

  // Create article
  const article = await createArticle(
    {
      workspaceId: input.workspaceId,
      title: parsed.title,
      content: parsed.content,
      categoryId: input.categoryId ?? null,
      tagIds: input.tagIds,
      sourceType: "FILE",
      sourceFileId: kbFile.id,
    },
    userId,
    userRole,
  );

  void logActivity({
    workspaceId: input.workspaceId,
    actorId: userId,
    action: "KB_ARTICLE_IMPORTED_FROM_FILE",
    entityType: "KbArticle",
    entityId: article.id,
    summary: generateSummary("KB_ARTICLE_IMPORTED_FROM_FILE", {
      kbArticleTitle: article.title,
    }),
    metadata: { articleTitle: article.title, sourceFile: input.file.name },
  });

  return article;
}

// ─── importFromUrl ────────────────────────────────────────────────────────────

export async function importFromUrl(
  input: {
    workspaceId: string;
    url: string;
    categoryId?: string;
    tagIds?: string[];
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbArticleSummary> {
  const membership = await checkMembership(input.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const parsed = await parseUrl(input.url);

  const article = await createArticle(
    {
      workspaceId: input.workspaceId,
      title: parsed.title,
      content: parsed.content,
      categoryId: input.categoryId ?? null,
      tagIds: input.tagIds,
      sourceType: "URL",
      sourceUrl: parsed.finalUrl,
      lastSyncedAt: new Date(),
    },
    userId,
    userRole,
  );

  void logActivity({
    workspaceId: input.workspaceId,
    actorId: userId,
    action: "KB_ARTICLE_IMPORTED_FROM_URL",
    entityType: "KbArticle",
    entityId: article.id,
    summary: generateSummary("KB_ARTICLE_IMPORTED_FROM_URL", {
      kbArticleTitle: article.title,
      sourceUrl: parsed.finalUrl,
    }),
    metadata: { articleTitle: article.title, sourceUrl: parsed.finalUrl },
  });

  return article;
}
