import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/project.service";
import { NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: { id: string } };

const addItemSchema = z.object({
  text: z.string().min(1).max(500),
});

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const task = await db.task.findUnique({
      where: { id: params.id },
      select: { projectId: true },
    });
    if (!task) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);

    const membership = await checkMembership(task.projectId, session.user.id);
    if (!membership && session.user.role !== "ADMIN") {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }

    const body: unknown = await req.json();
    const { text } = addItemSchema.parse(body);

    const maxPos = await db.checklistItem.findFirst({
      where: { taskId: params.id },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const item = await db.checklistItem.create({
      data: {
        taskId: params.id,
        text,
        position: maxPos ? maxPos.position + 1 : 0,
      },
    });
    return NextResponse.json(item, { status: 201 });
  });
}
