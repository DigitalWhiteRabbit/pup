import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim() ?? "";
    const workspaceId = searchParams.get("workspaceId");

    if (q.length < 2) {
      return NextResponse.json([]);
    }

    // Get existing member IDs to exclude them
    let excludeIds: string[] = [];
    if (workspaceId) {
      const members = await db.workspaceMember.findMany({
        where: { workspaceId },
        select: { userId: true },
      });
      excludeIds = members.map((m) => m.userId);
    }

    const users = await db.user.findMany({
      where: {
        isActive: true,
        id: { notIn: excludeIds.length > 0 ? excludeIds : undefined },
        OR: [{ login: { contains: q } }, { email: { contains: q } }],
      },
      select: { id: true, login: true, email: true },
      take: 10,
      orderBy: { login: "asc" },
    });

    return NextResponse.json(users);
  });
}
