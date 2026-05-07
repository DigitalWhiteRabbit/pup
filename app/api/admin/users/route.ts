import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { createUserSchema } from "@/lib/schemas/user.schema";
import * as authService from "@/lib/services/auth.service";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Доступ запрещён", "FORBIDDEN", 403);
    }

    const body: unknown = await req.json();
    const input = createUserSchema.parse(body);

    const { user, temporaryPassword } = await authService.createUser(input);

    return NextResponse.json(
      {
        id: user.id,
        login: user.login,
        email: user.email,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt.toISOString(),
        temporaryPassword,
      },
      { status: 201 },
    );
  });
}

export async function GET(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session || session.user.role !== "ADMIN") {
      throw new ApiError("Доступ запрещён", "FORBIDDEN", 403);
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") ?? "50", 10)),
    );
    const search = searchParams.get("search") ?? undefined;

    const where = search
      ? {
          OR: [
            { login: { contains: search } },
            { email: { contains: search } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          login: true,
          email: true,
          role: true,
          isActive: true,
          telegramChatId: true,
          createdAt: true,
        },
      }),
      db.user.count({ where }),
    ]);

    const data = users.map((u) => ({
      id: u.id,
      login: u.login,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      telegramConnected: u.telegramChatId !== null,
      createdAt: u.createdAt.toISOString(),
    }));

    return NextResponse.json({ data, total, page, pageSize });
  });
}
