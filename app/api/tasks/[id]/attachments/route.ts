import { auth } from "@/lib/auth";
import { withErrorHandler, apiError, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { uploadAttachment } from "@/lib/services/attachment.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
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

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file || !(file instanceof File)) {
      return apiError("Файл не передан", "VALIDATION_ERROR", 400);
    }

    const result = await uploadAttachment(
      { taskId: params.id, file, uploadedById: session.user.id },
      session.user.role,
    );

    return NextResponse.json(result, { status: 201 });
  });
}
