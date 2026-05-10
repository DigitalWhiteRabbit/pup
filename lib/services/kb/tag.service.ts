import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";

export type KbTagItem = {
  id: string;
  name: string;
  color: string;
};

export async function listTags(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  opts?: { search?: string },
): Promise<KbTagItem[]> {
  const _mc1 = await checkMembership(workspaceId, userId);
  if (!_mc1 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  return db.kbTag.findMany({
    where: {
      workspaceId,
      ...(opts?.search && { name: { contains: opts.search } }),
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });
}

export async function createTag(
  workspaceId: string,
  input: { name: string; color: string },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbTagItem> {
  const _mc2 = await checkMembership(workspaceId, userId);
  if (!_mc2 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const existing = await db.kbTag.findUnique({
    where: { workspaceId_name: { workspaceId, name: input.name } },
  });
  if (existing)
    throw new ApiError("Тег с таким именем уже существует", "DUPLICATE", 409);

  const tag = await db.kbTag.create({
    data: { workspaceId, name: input.name, color: input.color },
    select: { id: true, name: true, color: true },
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "KB_TAG_CREATED",
    entityType: "KbTag",
    entityId: tag.id,
    summary: generateSummary("KB_TAG_CREATED", { kbTagName: tag.name }),
    metadata: { tagName: tag.name },
  });

  return tag;
}

export async function deleteTag(
  tagId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const tag = await db.kbTag.findUnique({
    where: { id: tagId },
    select: { id: true, workspaceId: true, name: true },
  });
  if (!tag) throw new ApiError("Тег не найден", "NOT_FOUND", 404);

  const _mc3 = await checkMembership(tag.workspaceId, userId);
  if (!_mc3 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  await db.kbTag.delete({ where: { id: tagId } });

  void logActivity({
    workspaceId: tag.workspaceId,
    actorId: userId,
    action: "KB_TAG_DELETED",
    entityType: "KbTag",
    entityId: tagId,
    summary: generateSummary("KB_TAG_DELETED", { kbTagName: tag.name }),
    metadata: { tagName: tag.name },
  });
}
