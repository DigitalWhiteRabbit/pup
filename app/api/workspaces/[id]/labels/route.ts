import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  resolveAuth,
  requireScope,
  requireWorkspace,
} from "@/lib/middleware/resolve-auth";

type Params = { params: { id: string } };

const createLabelSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const ctx = await resolveAuth(req);
    if (!ctx) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    requireScope(ctx, "tasks:read");
    requireWorkspace(ctx, params.id);

    if (ctx.type === "user") {
      const membership = await checkMembership(params.id, ctx.id);
      if (!membership && ctx.role !== "ADMIN") {
        throw new ApiError("Нет доступа", "FORBIDDEN", 403);
      }
    }

    const labels = await db.label.findMany({
      where: { workspaceId: params.id },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(labels);
  });
}

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const membership = await checkMembership(params.id, session.user.id);
    if (!membership && session.user.role !== "ADMIN") {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }

    const body: unknown = await req.json();
    const { name, color } = createLabelSchema.parse(body);

    const label = await db.label.create({
      data: { workspaceId: params.id, name, color },
    });
    return NextResponse.json(label, { status: 201 });
  });
}
