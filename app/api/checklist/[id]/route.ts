import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { checkMembership } from "@/lib/services/workspace.service";
import { NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: { id: string } };

const updateSchema = z.object({
  text: z.string().min(1).max(500).optional(),
  checked: z.boolean().optional(),
});

async function getItemWithAccess(itemId: string, userId: string, role: string) {
  const item = await db.checklistItem.findUnique({
    where: { id: itemId },
    include: { task: { select: { workspaceId: true } } },
  });
  if (!item) throw new ApiError("Элемент не найден", "NOT_FOUND", 404);

  const membership = await checkMembership(item.task.workspaceId, userId);
  if (!membership && role !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }
  return item;
}

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const item = await getItemWithAccess(
      params.id,
      session.user.id,
      session.user.role,
    );
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      item.task.workspaceId,
      { module: "crm" },
    );

    const body: unknown = await req.json();
    const data = updateSchema.parse(body);

    const updated = await db.checklistItem.update({
      where: { id: params.id },
      data,
    });
    return NextResponse.json(updated);
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const item = await getItemWithAccess(
      params.id,
      session.user.id,
      session.user.role,
    );
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      item.task.workspaceId,
      { module: "crm" },
    );

    await db.checklistItem.delete({ where: { id: params.id } });
    return new NextResponse(null, { status: 204 });
  });
}
