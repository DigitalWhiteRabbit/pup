import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { listArticles, createArticle } from "@/lib/services/kb/article.service";
import {
  createArticleSchema,
  listArticlesSchema,
} from "@/lib/schemas/kb.schema";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const { searchParams } = new URL(req.url);
    const parsed = listArticlesSchema.parse(Object.fromEntries(searchParams));

    const result = await listArticles(
      params.id,
      session.user.id,
      session.user.role,
      {
        page: parsed.page,
        pageSize: parsed.pageSize,
        categoryId: parsed.categoryId,
        tagIds: parsed.tagIds
          ? parsed.tagIds.split(",").filter(Boolean)
          : undefined,
        authorId: parsed.authorId,
        isPublished: parsed.isPublished,
        search: parsed.search,
      },
    );

    return NextResponse.json(result);
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const data = createArticleSchema.parse(body);

    const article = await createArticle(
      { workspaceId: params.id, ...data },
      session.user.id,
      session.user.role,
    );

    return NextResponse.json(article, { status: 201 });
  });
}
