import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { deleteTag } from "@/lib/services/kb/tag.service";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { tagId: string } },
) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const ent = await db.kbTag.findUnique({
      where: { id: params.tagId },
      select: { workspaceId: true },
    });
    if (!ent) throw new ApiError("Тег не найден", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.workspaceId,
      {
        module: "knowledge",
      },
    );

    await deleteTag(params.tagId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
