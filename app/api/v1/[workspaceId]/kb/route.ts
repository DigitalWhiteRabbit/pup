import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/kb?search=&categoryId=&limit=50&offset=0
 * Scope: kb:read
 *
 * Knowledge base articles with content, categories, and tags.
 */
export const GET = withServiceAuth("kb:read", async (req, workspaceId) => {
  const url = new URL(req.url);
  const search = url.searchParams.get("search") ?? undefined;
  const categoryId = url.searchParams.get("categoryId") ?? undefined;
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {
    workspaceId,
    isPublished: true,
  };

  if (categoryId) {
    where.categoryId = categoryId;
  }

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { searchText: { contains: search } },
    ];
  }

  const [articles, total, categories] = await Promise.all([
    db.kbArticle.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        title: true,
        slug: true,
        content: true,
        sourceType: true,
        sourceUrl: true,
        isPublished: true,
        createdAt: true,
        updatedAt: true,
        category: {
          select: { id: true, name: true, slug: true, color: true },
        },
        tags: {
          select: {
            tag: { select: { id: true, name: true, color: true } },
          },
        },
        author: {
          select: { id: true, login: true },
        },
      },
    }),
    db.kbArticle.count({ where }),
    // Also return available categories for reference
    db.kbCategory.findMany({
      where: { workspaceId },
      orderBy: { position: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        color: true,
        _count: { select: { articles: true } },
      },
    }),
  ]);

  const data = articles.map((a) => ({
    id: a.id,
    title: a.title,
    slug: a.slug,
    content: a.content,
    sourceType: a.sourceType,
    sourceUrl: a.sourceUrl,
    category: a.category,
    tags: a.tags.map((t) => t.tag),
    author: a.author,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));

  return NextResponse.json({
    data,
    total,
    limit,
    offset,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      color: c.color,
      articleCount: c._count.articles,
    })),
  });
});
