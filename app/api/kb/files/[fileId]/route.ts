import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { deleteKbFile } from "@/lib/services/kb/file.service";

type Params = { params: { fileId: string } };

export async function DELETE(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const ent = await db.kbFile.findUnique({
      where: { id: params.fileId },
      select: { workspaceId: true },
    });
    if (!ent) throw new ApiError("Файл не найден", "NOT_FOUND", 404);
    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      ent.workspaceId,
      {
        module: "knowledge",
      },
    );

    await deleteKbFile(params.fileId, session.user.id, session.user.role);
    return NextResponse.json({ ok: true });
  });
}
