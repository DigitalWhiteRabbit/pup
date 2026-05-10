import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { listCrawls } from "@/lib/services/kb/crawler.service";
import { ApiError } from "@/lib/api-error";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: workspaceId } = await params;
    const crawls = await listCrawls(
      workspaceId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json(crawls);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[GET /kb/crawls]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
