import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import slugify from "slugify";
import type { KbSourceType } from "@prisma/client";
import { diffLines } from "diff";
import { buildSearchText } from "./utils";
import { queueArticleIndex } from "./index.service";
import {
  normalizeUrl,
  computeContentHash,
  findDuplicate,
} from "./dedup.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export type KbArticleSummary = {
  id: string;
  title: string;
  slug: string;
  contentPreview: string;
  categoryId: string | null;
  category: { id: string; name: string; color: string } | null;
  tags: Array<{ id: string; name: string; color: string }>;
  author: { id: string; login: string } | null;
  lastEditedBy: { id: string; login: string } | null;
  isPublished: boolean;
  versionsCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type KbArticleFull = KbArticleSummary & {
  content: string;
  sourceType: KbSourceType;
  sourceUrl: string | null;
  lastSyncedAt: Date | null;
};

export type KbArticleVersionItem = {
  id: string;
  title: string;
  contentPreview: string;
  editedBy: { id: string; login: string } | null;
  editedAt: Date;
  reason: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toContentPreview(content: string, maxLen = 200): string {
  // Strip basic markdown: headers, bold/italic, code blocks
  const stripped = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
  return stripped.length > maxLen ? stripped.slice(0, maxLen) + "…" : stripped;
}

async function generateUniqueSlug(
  workspaceId: string,
  title: string,
  excludeId?: string,
): Promise<string> {
  const base =
    slugify(title, { lower: true, strict: true, locale: "ru" }) || "article";
  let slug = base;
  let suffix = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db.kbArticle.findFirst({
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

function mapArticleSummary(article: {
  id: string;
  title: string;
  slug: string;
  content: string;
  categoryId: string | null;
  category: { id: string; name: string; color: string } | null;
  tags: Array<{ tag: { id: string; name: string; color: string } }>;
  author: { id: string; login: string } | null;
  lastEditedBy: { id: string; login: string } | null;
  isPublished: boolean;
  _count: { versions: number };
  createdAt: Date;
  updatedAt: Date;
}): KbArticleSummary {
  return {
    id: article.id,
    title: article.title,
    slug: article.slug,
    contentPreview: toContentPreview(article.content),
    categoryId: article.categoryId,
    category: article.category,
    tags: article.tags.map((t) => t.tag),
    author: article.author,
    lastEditedBy: article.lastEditedBy,
    isPublished: article.isPublished,
    versionsCount: article._count.versions,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

const articleInclude = {
  category: { select: { id: true, name: true, color: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
  author: { select: { id: true, login: true } },
  lastEditedBy: { select: { id: true, login: true } },
  _count: { select: { versions: true } },
} as const;

// ─── createArticle ────────────────────────────────────────────────────────────

/**
 * Dedup helper: a re-collection matched an existing article by normalized URL,
 * so update it in place (version snapshot + content/hash refresh + re-index)
 * instead of creating a duplicate. Returns the updated article summary.
 */
async function updateExistingFromIngest(
  articleId: string,
  input: {
    workspaceId: string;
    title: string;
    content: string;
    lastSyncedAt?: Date;
  },
  userId: string,
  normalizedUrl: string | null,
  contentHash: string | null,
): Promise<KbArticleSummary> {
  const searchText = buildSearchText(input.title, input.content);
  const updated = await db.$transaction(async (tx) => {
    const cur = await tx.kbArticle.findUnique({ where: { id: articleId } });
    if (cur && cur.content !== input.content) {
      await tx.kbArticleVersion.create({
        data: {
          articleId,
          title: cur.title,
          content: cur.content,
          editedById: userId,
          reason: "Пере-сбор из источника (дедуп)",
        },
      });
    }
    return tx.kbArticle.update({
      where: { id: articleId },
      data: {
        title: input.title,
        content: input.content,
        searchText,
        searchTextUpdatedAt: new Date(),
        normalizedUrl,
        contentHash,
        lastSyncedAt: input.lastSyncedAt ?? new Date(),
        lastEditedById: userId,
      },
      include: articleInclude,
    });
  });

  queueArticleIndex(input.workspaceId, {
    id: articleId,
    content: input.content,
  });
  return mapArticleSummary(updated);
}

export async function createArticle(
  input: {
    workspaceId: string;
    title: string;
    content: string;
    categoryId?: string | null;
    tagIds?: string[];
    isPublished?: boolean;
    sourceType?: KbSourceType;
    sourceUrl?: string;
    sourceFileId?: string;
    lastSyncedAt?: Date;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbArticleSummary> {
  const _m1 = await checkMembership(input.workspaceId, userId);
  if (!_m1 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  // Dedup fields (always stored for audit). Detection runs only for ingest
  // paths (URL/CRAWL/FILE) — manual authoring is never blocked/merged.
  const normalizedUrl = normalizeUrl(input.sourceUrl);
  const contentHash = computeContentHash(input.content);
  const isIngest = (input.sourceType ?? "MANUAL") !== "MANUAL";

  if (isIngest) {
    const dup = await findDuplicate(input.workspaceId, {
      normalizedUrl,
      contentHash,
    });
    if (dup?.match === "url") {
      // Re-collection of the same source → update the existing article,
      // never create a second one.
      console.log(
        `[kb.dedup] re-collect same URL → update existing=${dup.article.id} ws=${input.workspaceId}`,
      );
      return updateExistingFromIngest(
        dup.article.id,
        input,
        userId,
        normalizedUrl,
        contentHash,
      );
    }
    if (dup?.match === "content") {
      // Same content at a different URL → do not create a duplicate.
      console.log(
        `[kb.dedup] skip content-duplicate ws=${input.workspaceId} existing=${dup.article.id} altUrl=${input.sourceUrl ?? ""}`,
      );
      const existing = await db.kbArticle.findUnique({
        where: { id: dup.article.id },
        include: articleInclude,
      });
      if (existing) return mapArticleSummary(existing);
      // Fall through to create if the existing row vanished (race).
    }
  }

  const slug = await generateUniqueSlug(input.workspaceId, input.title);
  const searchText = buildSearchText(input.title, input.content);

  const article = await db.$transaction(async (tx) => {
    const created = await tx.kbArticle.create({
      data: {
        workspaceId: input.workspaceId,
        title: input.title,
        slug,
        content: input.content,
        searchText,
        searchTextUpdatedAt: new Date(),
        categoryId: input.categoryId ?? null,
        authorId: userId,
        lastEditedById: userId,
        isPublished: input.isPublished ?? true,
        sourceType: input.sourceType ?? "MANUAL",
        sourceUrl: input.sourceUrl ?? null,
        sourceFileId: input.sourceFileId ?? null,
        lastSyncedAt: input.lastSyncedAt ?? null,
        normalizedUrl,
        contentHash,
        tags: input.tagIds?.length
          ? { create: input.tagIds.map((tagId) => ({ tagId })) }
          : undefined,
      },
      include: articleInclude,
    });

    // First version snapshot
    await tx.kbArticleVersion.create({
      data: {
        articleId: created.id,
        title: created.title,
        content: input.content,
        editedById: userId,
        reason: "Создание статьи",
      },
    });

    return created;
  });

  void logActivity({
    workspaceId: input.workspaceId,
    actorId: userId,
    action: "KB_ARTICLE_CREATED",
    entityType: "KbArticle",
    entityId: article.id,
    summary: generateSummary("KB_ARTICLE_CREATED", {
      kbArticleTitle: article.title,
    }),
    metadata: { articleTitle: article.title },
  });

  // KB-vector: index content in the background (does NOT block the response).
  queueArticleIndex(input.workspaceId, {
    id: article.id,
    content: input.content,
  });

  return mapArticleSummary(article);
}

// ─── updateArticle ────────────────────────────────────────────────────────────

export async function updateArticle(
  articleId: string,
  data: {
    title?: string;
    content?: string;
    categoryId?: string | null;
    tagIds?: string[];
    isPublished?: boolean;
    reason?: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbArticleSummary> {
  const current = await db.kbArticle.findUnique({
    where: { id: articleId },
    include: articleInclude,
  });
  if (!current) throw new ApiError("Статья не найдена", "NOT_FOUND", 404);

  const _mc1 = await checkMembership(current.workspaceId, userId);
  if (!_mc1 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const newSlug =
    data.title && data.title !== current.title
      ? await generateUniqueSlug(current.workspaceId, data.title, articleId)
      : current.slug;

  const updated = await db.$transaction(async (tx) => {
    // Snapshot BEFORE update
    await tx.kbArticleVersion.create({
      data: {
        articleId,
        title: current.title,
        content: current.content,
        editedById: userId,
        reason: data.reason ?? null,
      },
    });

    if (data.tagIds !== undefined) {
      await tx.kbArticleTag.deleteMany({ where: { articleId } });
      if (data.tagIds.length > 0) {
        await tx.kbArticleTag.createMany({
          data: data.tagIds.map((tagId) => ({ articleId, tagId })),
        });
      }
    }

    // Recompute searchText if title or content changed
    const needsSearchUpdate =
      data.title !== undefined || data.content !== undefined;
    const newSearchText = needsSearchUpdate
      ? buildSearchText(
          data.title ?? current.title,
          data.content ?? current.content,
        )
      : undefined;

    return tx.kbArticle.update({
      where: { id: articleId },
      data: {
        ...(data.title !== undefined && { title: data.title, slug: newSlug }),
        ...(data.content !== undefined && {
          content: data.content,
          contentHash: computeContentHash(data.content),
        }),
        ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
        ...(data.isPublished !== undefined && {
          isPublished: data.isPublished,
        }),
        ...(newSearchText !== undefined && {
          searchText: newSearchText,
          searchTextUpdatedAt: new Date(),
        }),
        lastEditedById: userId,
      },
      include: articleInclude,
    });
  });

  void logActivity({
    workspaceId: current.workspaceId,
    actorId: userId,
    action: "KB_ARTICLE_UPDATED",
    entityType: "KbArticle",
    entityId: articleId,
    summary: generateSummary("KB_ARTICLE_UPDATED", {
      kbArticleTitle: updated.title,
    }),
    metadata: { articleTitle: updated.title },
  });

  // KB-vector: re-index in the background ONLY when content actually changed.
  if (data.content !== undefined && data.content !== current.content) {
    queueArticleIndex(current.workspaceId, {
      id: articleId,
      content: data.content,
    });
  }

  return mapArticleSummary(updated);
}

// ─── deleteArticle ────────────────────────────────────────────────────────────

export async function deleteArticle(
  articleId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const article = await db.kbArticle.findUnique({
    where: { id: articleId },
    select: { id: true, workspaceId: true, title: true },
  });
  if (!article) throw new ApiError("Статья не найдена", "NOT_FOUND", 404);

  const _mc3 = await checkMembership(article.workspaceId, userId);
  if (!_mc3 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.kbArticle.delete({ where: { id: articleId } });

  void logActivity({
    workspaceId: article.workspaceId,
    actorId: userId,
    action: "KB_ARTICLE_DELETED",
    entityType: "KbArticle",
    entityId: articleId,
    summary: generateSummary("KB_ARTICLE_DELETED", {
      kbArticleTitle: article.title,
    }),
    metadata: { articleTitle: article.title },
  });
}

// ─── getArticleById ───────────────────────────────────────────────────────────

export async function getArticleById(
  articleId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbArticleFull> {
  const article = await db.kbArticle.findUnique({
    where: { id: articleId },
    include: { ...articleInclude, workspace: { select: { id: true } } },
  });
  if (!article) throw new ApiError("Статья не найдена", "NOT_FOUND", 404);

  const _mc5 = await checkMembership(article.workspaceId, userId);
  if (!_mc5 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  return {
    ...mapArticleSummary(article),
    content: article.content,
    sourceType: article.sourceType,
    sourceUrl: article.sourceUrl,
    lastSyncedAt: article.lastSyncedAt,
  };
}

// ─── listArticles ─────────────────────────────────────────────────────────────

export async function listArticles(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  filters: {
    page?: number;
    pageSize?: number;
    categoryId?: string;
    tagIds?: string[];
    authorId?: string;
    isPublished?: boolean;
    search?: string;
  } = {},
): Promise<{ data: KbArticleSummary[]; total: number }> {
  const _mc7 = await checkMembership(workspaceId, userId);
  if (!_mc7 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const skip = (page - 1) * pageSize;

  const where = {
    workspaceId,
    ...(filters.categoryId !== undefined && { categoryId: filters.categoryId }),
    ...(filters.authorId && { authorId: filters.authorId }),
    ...(filters.isPublished !== undefined && {
      isPublished: filters.isPublished,
    }),
    ...(filters.search && { title: { contains: filters.search } }),
    ...(filters.tagIds?.length && {
      tags: { some: { tagId: { in: filters.tagIds } } },
    }),
  };

  const [articles, total] = await db.$transaction([
    db.kbArticle.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { updatedAt: "desc" },
      include: articleInclude,
    }),
    db.kbArticle.count({ where }),
  ]);

  return { data: articles.map(mapArticleSummary), total };
}

// ─── getArticleHistory ────────────────────────────────────────────────────────

export async function getArticleHistory(
  articleId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbArticleVersionItem[]> {
  const article = await db.kbArticle.findUnique({
    where: { id: articleId },
    select: { workspaceId: true },
  });
  if (!article) throw new ApiError("Статья не найдена", "NOT_FOUND", 404);

  const _mc9 = await checkMembership(article.workspaceId, userId);
  if (!_mc9 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const versions = await db.kbArticleVersion.findMany({
    where: { articleId },
    orderBy: { editedAt: "desc" },
    include: { editedBy: { select: { id: true, login: true } } },
  });

  return versions.map((v) => ({
    id: v.id,
    title: v.title,
    contentPreview: toContentPreview(v.content, 300),
    editedBy: v.editedBy,
    editedAt: v.editedAt,
    reason: v.reason,
  }));
}

// ─── restoreArticleVersion ────────────────────────────────────────────────────

export async function restoreArticleVersion(
  articleId: string,
  versionId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<KbArticleSummary> {
  const version = await db.kbArticleVersion.findUnique({
    where: { id: versionId },
    include: {
      article: { select: { workspaceId: true, title: true, content: true } },
    },
  });
  if (!version || version.articleId !== articleId) {
    throw new ApiError("Версия не найдена", "NOT_FOUND", 404);
  }

  const _mc11 = await checkMembership(version.article.workspaceId, userId);
  if (!_mc11 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const versionDate = version.editedAt.toLocaleString("ru-RU");

  const updated = await db.$transaction(async (tx) => {
    // Snapshot current before restoring
    await tx.kbArticleVersion.create({
      data: {
        articleId,
        title: version.article.title,
        content: version.article.content,
        editedById: userId,
        reason: `Восстановлено из версии от ${versionDate}`,
      },
    });

    return tx.kbArticle.update({
      where: { id: articleId },
      data: {
        title: version.title,
        content: version.content,
        lastEditedById: userId,
        searchText: buildSearchText(version.title, version.content),
        searchTextUpdatedAt: new Date(),
      },
      include: articleInclude,
    });
  });

  void logActivity({
    workspaceId: version.article.workspaceId,
    actorId: userId,
    action: "KB_ARTICLE_VERSION_RESTORED",
    entityType: "KbArticle",
    entityId: articleId,
    summary: generateSummary("KB_ARTICLE_VERSION_RESTORED", {
      kbArticleTitle: updated.title,
    }),
    metadata: { articleTitle: updated.title, versionId },
  });

  // KB-vector: re-index restored content in the background.
  queueArticleIndex(version.article.workspaceId, {
    id: articleId,
    content: version.content,
  });

  return mapArticleSummary(updated);
}

// ─── refreshFromUrl ───────────────────────────────────────────────────────────

export type ContentDiffEntry = {
  type: "added" | "removed" | "unchanged";
  value: string;
};

export type RefreshResult = {
  changed: boolean;
  diff: {
    titleChanged: boolean;
    oldTitle: string;
    newTitle: string;
    contentDiff: ContentDiffEntry[];
    addedLines: number;
    removedLines: number;
  };
  newVersion: KbArticleSummary | null;
};

export async function refreshFromUrl(
  articleId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  preview = true,
): Promise<RefreshResult> {
  const article = await db.kbArticle.findUnique({
    where: { id: articleId },
    include: articleInclude,
  });
  if (!article) throw new ApiError("Статья не найдена", "NOT_FOUND", 404);
  if (article.sourceType !== "URL" || !article.sourceUrl) {
    throw new ApiError(
      "Статья не связана с URL-источником",
      "INVALID_SOURCE_TYPE",
      400,
    );
  }

  const membership = await checkMembership(article.workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  // Dynamic import to avoid circular dependency issues
  const { parseUrl } = await import("./url-parser.service");
  const fetched = await parseUrl(article.sourceUrl);

  const titleChanged = fetched.title !== article.title;

  const rawDiff = diffLines(article.content, fetched.content);
  const contentDiff: ContentDiffEntry[] = rawDiff.map((part) => ({
    type: part.added ? "added" : part.removed ? "removed" : "unchanged",
    value: part.value,
  }));

  const addedLines = rawDiff
    .filter((p) => p.added)
    .reduce((s, p) => s + (p.count ?? 0), 0);
  const removedLines = rawDiff
    .filter((p) => p.removed)
    .reduce((s, p) => s + (p.count ?? 0), 0);

  const changed = titleChanged || addedLines > 0 || removedLines > 0;

  if (!preview && changed) {
    const updated = await db.$transaction(async (tx) => {
      await tx.kbArticleVersion.create({
        data: {
          articleId,
          title: article.title,
          content: article.content,
          editedById: userId,
          reason: `Обновлено из источника: ${article.sourceUrl}`,
        },
      });

      return tx.kbArticle.update({
        where: { id: articleId },
        data: {
          title: fetched.title,
          content: fetched.content,
          lastEditedById: userId,
          lastSyncedAt: new Date(),
          searchText: buildSearchText(fetched.title, fetched.content),
          searchTextUpdatedAt: new Date(),
          normalizedUrl: normalizeUrl(article.sourceUrl),
          contentHash: computeContentHash(fetched.content),
        },
        include: articleInclude,
      });
    });

    void logActivity({
      workspaceId: article.workspaceId,
      actorId: userId,
      action: "KB_ARTICLE_REFRESHED_FROM_URL",
      entityType: "KbArticle",
      entityId: articleId,
      summary: generateSummary("KB_ARTICLE_REFRESHED_FROM_URL", {
        kbArticleTitle: updated.title,
        sourceUrl: article.sourceUrl,
      }),
      metadata: { addedLines, removedLines, sourceUrl: article.sourceUrl },
    });

    // KB-vector: re-index refreshed content in the background.
    queueArticleIndex(article.workspaceId, {
      id: articleId,
      content: fetched.content,
    });

    return {
      changed: true,
      diff: {
        titleChanged,
        oldTitle: article.title,
        newTitle: fetched.title,
        contentDiff,
        addedLines,
        removedLines,
      },
      newVersion: mapArticleSummary(updated),
    };
  }

  return {
    changed,
    diff: {
      titleChanged,
      oldTitle: article.title,
      newTitle: fetched.title,
      contentDiff,
      addedLines,
      removedLines,
    },
    newVersion: null,
  };
}
