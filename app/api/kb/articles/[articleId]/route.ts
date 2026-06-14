import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import {
  getArticleById,
  updateArticle,
  deleteArticle,
} from "@/lib/services/kb/article.service";
import { updateArticleSchema } from "@/lib/schemas/kb.schema";

type Params = { params: { articleId: string } };

async function requireArticleAccess(
  session: { user: { id: string; role?: string | null } },
  articleId: string,
): Promise<void> {
  const ent = await db.kbArticle.findUnique({
    where: { id: articleId },
    select: { workspaceId: true },
  });
  if (!ent) throw new ApiError("Статья не найдена", "NOT_FOUND", 404);
  await requireWorkspaceAccess(accessCtxFromSession(session), ent.workspaceId, {
    module: "knowledge",
  });
}

export async function GET(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await requireArticleAccess(session, params.articleId);

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

    await requireArticleAccess(session, params.articleId);

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

    await requireArticleAccess(session, params.articleId);

    await deleteArticle(params.articleId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
