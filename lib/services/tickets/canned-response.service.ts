import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";

export type CannedResponseView = {
  id: string;
  shortCode: string;
  title: string;
  content: string;
  category: string | null;
  createdAt: Date;
};

export async function listCannedResponses(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<CannedResponseView[]> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  return db.cannedResponse.findMany({
    where: { workspaceId },
    orderBy: { shortCode: "asc" },
  });
}

export async function createCannedResponse(
  workspaceId: string,
  input: {
    shortCode: string;
    title: string;
    content: string;
    category?: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<CannedResponseView> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const code = input.shortCode.toLowerCase().replace(/[^a-zа-яё0-9_-]/gi, "");
  if (!code) throw new ApiError("Некорректный shortCode", "INVALID_CODE", 400);

  const existing = await db.cannedResponse.findUnique({
    where: { workspaceId_shortCode: { workspaceId, shortCode: code } },
  });
  if (existing)
    throw new ApiError(
      "Шаблон с таким кодом уже существует",
      "DUPLICATE_CODE",
      409,
    );

  const cr = await db.cannedResponse.create({
    data: {
      workspaceId,
      shortCode: code,
      title: input.title,
      content: input.content,
      category: input.category ?? null,
    },
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "CANNED_RESPONSE_CREATED",
    entityType: "CannedResponse",
    entityId: cr.id,
    summary: generateSummary("CANNED_RESPONSE_CREATED", {
      kbArticleTitle: `/${cr.shortCode}`,
    }),
    metadata: { shortCode: cr.shortCode },
  });

  return cr;
}

export async function updateCannedResponse(
  id: string,
  data: { title?: string; content?: string; category?: string | null },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<CannedResponseView> {
  const cr = await db.cannedResponse.findUnique({
    where: { id },
    select: { workspaceId: true, shortCode: true },
  });
  if (!cr) throw new ApiError("Шаблон не найден", "NOT_FOUND", 404);

  const m = await checkMembership(cr.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const updated = await db.cannedResponse.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.content !== undefined ? { content: data.content } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
    },
  });

  void logActivity({
    workspaceId: cr.workspaceId,
    actorId: userId,
    action: "CANNED_RESPONSE_UPDATED",
    entityType: "CannedResponse",
    entityId: id,
    summary: generateSummary("CANNED_RESPONSE_UPDATED", {
      kbArticleTitle: `/${cr.shortCode}`,
    }),
    metadata: data as Record<string, unknown>,
  });

  return updated;
}

export async function deleteCannedResponse(
  id: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const cr = await db.cannedResponse.findUnique({
    where: { id },
    select: { workspaceId: true, shortCode: true },
  });
  if (!cr) throw new ApiError("Шаблон не найден", "NOT_FOUND", 404);

  const m = await checkMembership(cr.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.cannedResponse.delete({ where: { id } });

  void logActivity({
    workspaceId: cr.workspaceId,
    actorId: userId,
    action: "CANNED_RESPONSE_DELETED",
    entityType: "CannedResponse",
    entityId: id,
    summary: generateSummary("CANNED_RESPONSE_DELETED", {
      kbArticleTitle: `/${cr.shortCode}`,
    }),
    metadata: {},
  });
}
