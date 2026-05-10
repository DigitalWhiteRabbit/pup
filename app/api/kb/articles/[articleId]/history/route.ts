import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { getArticleHistory } from "@/lib/services/kb/article.service";

export async function GET(
  _req: NextRequest,
  { params }: { params: { articleId: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const history = await getArticleHistory(
      params.articleId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(history);
  });
}
