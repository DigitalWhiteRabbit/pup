import { db } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import {
  resolveAuth,
  requireScope,
  ServiceRateLimitError,
} from "@/lib/middleware/resolve-auth";
import { ApiError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const ctx = await resolveAuth(req);
    if (!ctx)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    requireScope(ctx, "users:read");

    const since = new Date(Date.now() - 5 * 60 * 1000);

    const users = await db.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        login: true,
        role: true,
        lastSeenAt: true,
        avatarPath: true,
      },
      orderBy: { login: "asc" },
    });

    const result = users.map((u) => ({
      id: u.id,
      login: u.login,
      role: u.role,
      hasAvatar: !!u.avatarPath,
      online: u.lastSeenAt ? u.lastSeenAt >= since : false,
    }));

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceRateLimitError) return err.toResponse();
    if (err instanceof ApiError)
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      );
    return NextResponse.json({ error: "Ошибка сервера" }, { status: 500 });
  }
}
