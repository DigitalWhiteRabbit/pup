import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { getArticleHistory } from "@/lib/services/kb/article.service";

export async function GET(
  _req: NextRequest,
  { params }: { params: { articleId: string } },
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

    const history = await getArticleHistory(
      params.articleId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(history);
  });
}
