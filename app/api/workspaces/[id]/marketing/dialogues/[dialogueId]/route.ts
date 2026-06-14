import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type Params = { params: Promise<{ id: string; dialogueId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId, dialogueId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "marketing",
    });

    const dialogue = await db.mktDialogue.findFirst({
      where: { id: dialogueId, lead: { workspaceId } },
      include: { lead: true, messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!dialogue) throw new ApiError("Диалог не найден", "NOT_FOUND", 404);

    return NextResponse.json(dialogue);
  });
}
