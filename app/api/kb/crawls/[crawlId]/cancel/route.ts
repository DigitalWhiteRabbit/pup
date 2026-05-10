import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { cancelCrawl } from "@/lib/services/kb/crawler.service";
import { ApiError } from "@/lib/api-error";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ crawlId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { crawlId } = await params;
    await cancelCrawl(
      crawlId,
      session.user.id,
      session.user.role as "ADMIN" | "USER",
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    }
    console.error("[POST /kb/crawls/:id/cancel]", err);
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
