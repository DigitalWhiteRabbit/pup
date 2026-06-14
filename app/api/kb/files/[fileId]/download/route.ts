import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { downloadKbFile } from "@/lib/services/kb/file.service";

type Params = { params: { fileId: string } };

export async function GET(_req: NextRequest, { params }: Params) {
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

    const { stream, originalName, mimeType, size } = await downloadKbFile(
      params.fileId,
      session.user.id,
      session.user.role,
    );

    const encodedName = encodeURIComponent(originalName);
    return new NextResponse(stream, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
      },
    });
  });
}
