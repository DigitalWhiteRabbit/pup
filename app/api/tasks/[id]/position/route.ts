import { auth } from "@/lib/auth";
import { withErrorHandler, apiError, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { reorderTask } from "@/lib/services/task.service";
import { reorderTaskSchema } from "@/lib/schemas/task.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const ent = await db.task.findUnique({
      where: { id: params.id },
      select: { workspaceId: true },
    });
    if (!ent) throw new ApiError("Задача не найдена", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.workspaceId,
      {
        module: "crm",
      },
    );

    const body: unknown = await req.json();
    const input = reorderTaskSchema.parse(body);

    const result = await reorderTask(
      params.id,
      input.position,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(result);
  });
}
