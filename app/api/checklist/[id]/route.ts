import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/project.service";
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
    include: { task: { select: { projectId: true } } },
  });
  if (!item) throw new ApiError("Элемент не найден", "NOT_FOUND", 404);

  const membership = await checkMembership(item.task.projectId, userId);
  if (!membership && role !== "ADMIN") {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }
  return item;
}

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    await getItemWithAccess(params.id, session.user.id, session.user.role);

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

    await getItemWithAccess(params.id, session.user.id, session.user.role);

    await db.checklistItem.delete({ where: { id: params.id } });
    return new NextResponse(null, { status: 204 });
  });
}
