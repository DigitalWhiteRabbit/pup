import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: Promise<{ id: string; taskId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, taskId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const existing = await db.mktSearchTask.findFirst({
      where: { id: taskId, workspaceId },
    });
    if (!existing) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

    const body = await req.json();
    const task = await db.mktSearchTask.update({
      where: { id: taskId },
      data: body,
    });
    return NextResponse.json(task);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, taskId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const existing = await db.mktSearchTask.findFirst({
      where: { id: taskId, workspaceId },
    });
    if (!existing) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

    await db.mktSearchTask.delete({ where: { id: taskId } });
    return NextResponse.json({ ok: true });
  });
}
