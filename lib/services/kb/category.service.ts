import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import slugify from "slugify";

export type KbCategoryWithCount = {
  id: string;
  name: string;
  slug: string;
  color: string;
  icon: string | null;
  position: number;
  articlesCount: number;
  createdAt: Date;
};

async function generateUniqueCategorySlug(
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base =
    slugify(name, { lower: true, strict: true, locale: "ru" }) || "category";
  let slug = base;
  let suffix = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db.kbCategory.findFirst({
      where: {
        workspaceId,
        slug,
        ...(excludeId ? { NOT: { id: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (!existing) break;
    slug = `${base}-${suffix++}`;
  }
  return slug;
}

export async function listCategories(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbCategoryWithCount[]> {
  const _mc1 = await checkMembership(workspaceId, userId);
  if (!_mc1 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const cats = await db.kbCategory.findMany({
    where: { workspaceId },
    orderBy: { position: "asc" },
    include: { _count: { select: { articles: true } } },
  });

  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    color: c.color,
    icon: c.icon,
    position: c.position,
    articlesCount: c._count.articles,
    createdAt: c.createdAt,
  }));
}

export async function createCategory(
  workspaceId: string,
  input: { name: string; color: string; icon?: string; position?: number },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbCategoryWithCount> {
  const _mc2 = await checkMembership(workspaceId, userId);
  if (!_mc2 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const slug = await generateUniqueCategorySlug(workspaceId, input.name);

  const maxPos = await db.kbCategory.aggregate({
    where: { workspaceId },
    _max: { position: true },
  });
  const position = input.position ?? (maxPos._max.position ?? -1) + 1;

  const cat = await db.kbCategory.create({
    data: {
      workspaceId,
      name: input.name,
      slug,
      color: input.color,
      icon: input.icon,
      position,
    },
    include: { _count: { select: { articles: true } } },
  });

  void logActivity({
    workspaceId,
    actorId: userId,
    action: "KB_CATEGORY_CREATED",
    entityType: "KbCategory",
    entityId: cat.id,
    summary: generateSummary("KB_CATEGORY_CREATED", {
      kbCategoryName: cat.name,
    }),
    metadata: { categoryName: cat.name },
  });

  return {
    id: cat.id,
    name: cat.name,
    slug: cat.slug,
    color: cat.color,
    icon: cat.icon,
    position: cat.position,
    articlesCount: cat._count.articles,
    createdAt: cat.createdAt,
  };
}

export async function updateCategory(
  categoryId: string,
  data: { name?: string; color?: string; icon?: string | null },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbCategoryWithCount> {
  const cat = await db.kbCategory.findUnique({ where: { id: categoryId } });
  if (!cat) throw new ApiError("Категория не найдена", "NOT_FOUND", 404);

  const _mc3 = await checkMembership(cat.workspaceId, userId);
  if (!_mc3 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const newSlug =
    data.name && data.name !== cat.name
      ? await generateUniqueCategorySlug(cat.workspaceId, data.name, categoryId)
      : cat.slug;

  const updated = await db.kbCategory.update({
    where: { id: categoryId },
    data: {
      ...(data.name !== undefined && { name: data.name, slug: newSlug }),
      ...(data.color !== undefined && { color: data.color }),
      ...(data.icon !== undefined && { icon: data.icon }),
    },
    include: { _count: { select: { articles: true } } },
  });

  void logActivity({
    workspaceId: cat.workspaceId,
    actorId: userId,
    action: "KB_CATEGORY_UPDATED",
    entityType: "KbCategory",
    entityId: categoryId,
    summary: generateSummary("KB_CATEGORY_UPDATED", {
      kbCategoryName: updated.name,
    }),
    metadata: { categoryName: updated.name },
  });

  return {
    id: updated.id,
    name: updated.name,
    slug: updated.slug,
    color: updated.color,
    icon: updated.icon,
    position: updated.position,
    articlesCount: updated._count.articles,
    createdAt: updated.createdAt,
  };
}

export async function deleteCategory(
  categoryId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const cat = await db.kbCategory.findUnique({
    where: { id: categoryId },
    select: { id: true, workspaceId: true, name: true },
  });
  if (!cat) throw new ApiError("Категория не найдена", "NOT_FOUND", 404);

  const _mc4 = await checkMembership(cat.workspaceId, userId);
  if (!_mc4 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  await db.kbCategory.delete({ where: { id: categoryId } });

  void logActivity({
    workspaceId: cat.workspaceId,
    actorId: userId,
    action: "KB_CATEGORY_DELETED",
    entityType: "KbCategory",
    entityId: categoryId,
    summary: generateSummary("KB_CATEGORY_DELETED", {
      kbCategoryName: cat.name,
    }),
    metadata: { categoryName: cat.name },
  });
}

export async function reorderCategories(
  workspaceId: string,
  categoryIds: string[],
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const _mc5 = await checkMembership(workspaceId, userId);
  if (!_mc5 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.$transaction(
    categoryIds.map((id, index) =>
      db.kbCategory.update({ where: { id }, data: { position: index } }),
    ),
  );
}
