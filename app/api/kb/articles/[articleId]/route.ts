import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import {
  getArticleById,
  updateArticle,
  deleteArticle,
} from "@/lib/services/kb/article.service";
import { updateArticleSchema } from "@/lib/schemas/kb.schema";

type Params = { params: { articleId: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const article = await getArticleById(
      params.articleId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(article);
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const body: unknown = await req.json();
    const data = updateArticleSchema.parse(body);

    const article = await updateArticle(
      params.articleId,
      data,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(article);
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteArticle(params.articleId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
