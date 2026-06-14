import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { refreshFromUrl } from "@/lib/services/kb/article.service";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { z } from "zod";

const schema = z.object({
  preview: z.boolean().optional().default(true),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ articleId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { articleId } = await params;

    const ent = await db.kbArticle.findUnique({
      where: { id: articleId },
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

    const body: unknown = await request.json();
    const { preview } = schema.parse(body);

    const result = await refreshFromUrl(
      articleId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
      preview,
    );

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.errors[0]?.message ?? "Ошибка валидации" },
        { status: 400 },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[POST /kb/articles/:id/refresh]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
