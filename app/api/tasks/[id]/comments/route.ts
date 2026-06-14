import { auth } from "@/lib/auth";
import { withErrorHandler, apiError, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { createComment } from "@/lib/services/comment.service";
import { createCommentSchema } from "@/lib/schemas/comment.schema";
import { enforceRateLimit } from "@/lib/services/rate-limit";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) return apiError("Не авторизован", "UNAUTHORIZED", 401);
    const limited = enforceRateLimit({
      scope: "create:comment",
      userId: session.user.id,
      req,
      max: 300,
      windowMs: 60 * 60 * 1000,
    });
    if (limited) return limited;

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
    const input = createCommentSchema.parse(body);

    const comment = await createComment(
      { taskId: params.id, authorId: session.user.id, text: input.text },
      session.user.role,
    );

    return NextResponse.json(comment, { status: 201 });
  });
}
