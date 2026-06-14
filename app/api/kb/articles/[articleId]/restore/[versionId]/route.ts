import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { restoreArticleVersion } from "@/lib/services/kb/article.service";

export async function POST(
  _req: NextRequest,
  { params }: { params: { articleId: string; versionId: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const ent = await db.kbArticle.findUnique({
      where: { id: params.articleId },
      select: { workspaceId: true },
    });
    if (!ent) throw new ApiError("Статья не найдена", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.workspaceId,
      {
        module: "knowledge",
      },
    );

    const article = await restoreArticleVersion(
      params.articleId,
      params.versionId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(article);
  });
}
