import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";
import { checkMembership } from "@/lib/services/workspace.service";
import { extractFileTextOnDemand } from "@/lib/services/kb/file.service";

type Params = { params: { fileId: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const kbFile = await db.kbFile.findUnique({ where: { id: params.fileId } });
    if (!kbFile) throw new ApiError("Файл не найден", "NOT_FOUND", 404);

    await requireWorkspaceAccess(
      accessCtxFromSession(session),
      kbFile.workspaceId,
      { module: "knowledge" },
    );

    const membership = await checkMembership(
      kbFile.workspaceId,
      session.user.id,
    );
    if (!membership && session.user.role !== "ADMIN") {
      throw new ApiError("Нет доступа", "FORBIDDEN", 403);
    }

    // If already extracted, return immediately
    if (kbFile.extractedText && kbFile.extractedAt) {
      return NextResponse.json({
        content: kbFile.extractedText,
        extractedAt: kbFile.extractedAt.toISOString(),
        error: null,
      });
    }

    // If previous extraction failed, return the error
    if (kbFile.extractionError && kbFile.extractedAt) {
      return NextResponse.json({
        content: null,
        extractedAt: kbFile.extractedAt.toISOString(),
        error: kbFile.extractionError,
      });
    }

    // Not yet extracted -- extract on-demand
    const result = await extractFileTextOnDemand(kbFile.id);

    return NextResponse.json({
      content: result.content,
      extractedAt: result.extractedAt?.toISOString() ?? null,
      error: result.error,
    });
  });
}
