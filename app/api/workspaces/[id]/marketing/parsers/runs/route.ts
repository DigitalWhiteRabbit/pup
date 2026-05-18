import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;

    const runs = await db.mktSearchRun.findMany({
      where: { task: { workspaceId } },
      include: { task: { select: { name: true, source: true } } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return NextResponse.json(runs);
  });
}
