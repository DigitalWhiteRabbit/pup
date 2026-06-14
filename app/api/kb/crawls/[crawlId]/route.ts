import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { getCrawlStatus } from "@/lib/services/kb/crawler.service";
import { ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ crawlId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { crawlId } = await params;

    const ent = await db.kbCrawl.findUnique({
      where: { id: crawlId },
      select: { workspaceId: true },
    });
    if (!ent) throw new ApiError("Краул не найден", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.workspaceId,
      {
        module: "knowledge",
      },
    );

    const data = await getCrawlStatus(
      crawlId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[GET /kb/crawls/:id]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
