import { auth } from "@/lib/auth";
import { withErrorHandler, apiError, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { updateComment, deleteComment } from "@/lib/services/comment.service";
import { updateCommentSchema } from "@/lib/schemas/comment.schema";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const ent = await db.comment.findUnique({
      where: { id: params.id },
      select: { task: { select: { workspaceId: true } } },
    });
    if (!ent) throw new ApiError("Комментарий не найден", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.task.workspaceId,
      { module: "crm" },
    );

    const body: unknown = await req.json();
    const input = updateCommentSchema.parse(body);

    const result = await updateComment(params.id, input.text, session.user.id);

    return NextResponse.json(result);
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const ent = await db.comment.findUnique({
      where: { id: params.id },
      select: { task: { select: { workspaceId: true } } },
    });
    if (!ent) throw new ApiError("Комментарий не найден", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.task.workspaceId,
      { module: "crm" },
    );

    await deleteComment(params.id, session.user.id);
    return new NextResponse(null, { status: 204 });
  });
}
