import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import { stripMarkdown, generateSnippet, type SnippetSegment } from "./utils";
import type { KbSourceType } from "@prisma/client";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SearchQuery = {
  text?: string;
  page?: number;
  pageSize?: number;
  categoryIds?: string[];
  tagIds?: string[];
  authorIds?: string[];
  sourceTypes?: KbSourceType[];
  isPublished?: boolean;
  createdFrom?: Date;
  createdTo?: Date;
  updatedFrom?: Date;
  updatedTo?: Date;
  sortBy?: "relevance" | "createdAt" | "updatedAt" | "title";
  sortOrder?: "asc" | "desc";
};

export type SearchResultItem = {
  id: string;
  title: string;
  slug: string;
  contentPreview: string;
  highlightedSnippet: SnippetSegment[];
  category: { id: string; name: string; color: string } | null;
  tags: Array<{ id: string; name: string; color: string }>;
  author: { id: string; login: string } | null;
  sourceType: KbSourceType;
  sourceUrl: string | null;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
  relevanceScore: number;
};

export type SearchResult = {
  data: SearchResultItem[];
  total: number;
  query: SearchQuery;
};

// ─── Relevance scoring ───────────────────────────────────────────────────────

function getRelevanceScore(
  article: {
    title: string;
    content: string;
    searchText: string | null;
    category: { name: string } | null;
    tags: Array<{ tag: { name: string } }>;
    updatedAt: Date;
    _count: { versions: number };
  },
  queryText: string | undefined,
): number {
  if (!queryText || queryText.length < 2) return 0.5;

  const lowerQuery = queryText.toLowerCase();
  const lowerTitle = article.title.toLowerCase();
  let score = 0;

  // Title matching
  if (lowerTitle === lowerQuery) {
    score += 1.0;
  } else if (lowerTitle.startsWith(lowerQuery)) {
    score += 0.8;
  } else if (lowerTitle.includes(lowerQuery)) {
    score += 0.6;
  }

  // Category/tag matching
  const catMatch = article.category?.name.toLowerCase().includes(lowerQuery);
  const tagMatch = article.tags.some((t) =>
    t.tag.name.toLowerCase().includes(lowerQuery),
  );
  if (catMatch || tagMatch) score += 0.4;

  // Content matching (via searchText)
  const searchField = article.searchText ?? "";
  if (searchField.includes(lowerQuery) && score < 0.6) {
    score += 0.2;
  }

  // Freshness bonus
  const daysSinceUpdate =
    (Date.now() - article.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate < 30) score += 0.1;

  // Activity bonus
  if (article._count.versions > 3) score += 0.05;

  return Math.min(score, 1.0);
}

// ─── Content preview ─────────────────────────────────────────────────────────

function toContentPreview(content: string, maxLen = 200): string {
  const stripped = stripMarkdown(content);
  return stripped.length > maxLen
    ? stripped.slice(0, maxLen) + "..."
    : stripped;
}

// ─── searchArticles ──────────────────────────────────────────────────────────

const articleInclude = {
  category: { select: { id: true, name: true, color: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
  author: { select: { id: true, login: true } },
  _count: { select: { versions: true } },
} as const;

export async function searchArticles(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  query: SearchQuery,
): Promise<SearchResult> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  if (
    query.text !== undefined &&
    query.text.length > 0 &&
    query.text.length < 2
  ) {
    throw new ApiError(
      "Минимум 2 символа для поиска",
      "SEARCH_QUERY_TOO_SHORT",
      400,
    );
  }

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const skip = (page - 1) * pageSize;
  const sortBy = query.sortBy ?? (query.text ? "relevance" : "updatedAt");
  const sortOrder = query.sortOrder ?? (sortBy === "title" ? "asc" : "desc");

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { workspaceId };

  if (query.text && query.text.length >= 2) {
    where.OR = [
      { title: { contains: query.text } },
      { searchText: { contains: query.text.toLowerCase() } },
    ];
  }

  if (query.categoryIds?.length) {
    where.categoryId = { in: query.categoryIds };
  }
  if (query.tagIds?.length) {
    where.tags = { some: { tagId: { in: query.tagIds } } };
  }
  if (query.authorIds?.length) {
    where.authorId = { in: query.authorIds };
  }
  if (query.sourceTypes?.length) {
    where.sourceType = { in: query.sourceTypes };
  }
  if (query.isPublished !== undefined) {
    where.isPublished = query.isPublished;
  }

  // Date filters
  if (query.createdFrom || query.createdTo) {
    where.createdAt = {
      ...(query.createdFrom ? { gte: query.createdFrom } : {}),
      ...(query.createdTo ? { lte: query.createdTo } : {}),
    };
  }
  if (query.updatedFrom || query.updatedTo) {
    where.updatedAt = {
      ...(query.updatedFrom ? { gte: query.updatedFrom } : {}),
      ...(query.updatedTo ? { lte: query.updatedTo } : {}),
    };
  }

  // Determine orderBy for DB-level sorting (non-relevance)
  const orderBy =
    sortBy === "relevance" || sortBy === undefined
      ? { updatedAt: "desc" as const }
      : sortBy === "title"
        ? { title: sortOrder }
        : { [sortBy]: sortOrder };

  const findArgs = {
    where,
    skip: sortBy === "relevance" ? 0 : skip,
    take: sortBy === "relevance" ? 200 : pageSize,
    orderBy,
    include: articleInclude,
  };

  const [articles, total] = await db.$transaction([
    db.kbArticle.findMany(findArgs),
    db.kbArticle.count({ where }),
  ]);

  // Cap total for relevance sorting (we only scored 200 rows)
  const effectiveTotal = sortBy === "relevance" ? Math.min(total, 200) : total;

  let results: SearchResultItem[] = articles.map((a) => ({
    id: a.id,
    title: a.title,
    slug: a.slug,
    contentPreview: toContentPreview(a.content),
    highlightedSnippet: generateSnippet(
      a.searchText ?? stripMarkdown(a.content),
      query.text,
    ),
    category: a.category,
    tags: a.tags.map((t) => t.tag),
    author: a.author,
    sourceType: a.sourceType,
    sourceUrl: a.sourceUrl,
    isPublished: a.isPublished,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    relevanceScore: getRelevanceScore(a, query.text),
  }));

  // For relevance sorting — sort by score then paginate in JS
  if (sortBy === "relevance") {
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    results = results.slice(skip, skip + pageSize);
  }

  // Log search (only when text query is present)
  if (query.text && query.text.length >= 2) {
    // Fire-and-forget: save history + activity log
    void db.kbSearchHistory
      .create({
        data: {
          workspaceId,
          userId,
          query: query.text,
          resultCount: total,
        },
      })
      .catch(() => {});

    void logActivity({
      workspaceId,
      actorId: userId,
      action: "KB_SEARCH_PERFORMED",
      entityType: "KbSearch",
      summary: generateSummary("KB_SEARCH_PERFORMED", {
        kbArticleTitle: query.text,
      }),
      metadata: { query: query.text, resultCount: total },
    });
  }

  return { data: results, total: effectiveTotal, query };
}

// ─── getSearchHistory ────────────────────────────────────────────────────────

export async function getSearchHistory(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  limit = 10,
): Promise<Array<{ query: string; resultCount: number; searchedAt: Date }>> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }

  const records = await db.kbSearchHistory.findMany({
    where: { workspaceId, userId },
    orderBy: { searchedAt: "desc" },
    take: limit,
    select: { query: true, resultCount: true, searchedAt: true },
  });

  // Deduplicate by query text (keep most recent)
  const seen = new Set<string>();
  return records.filter((r) => {
    if (seen.has(r.query)) return false;
    seen.add(r.query);
    return true;
  });
}
