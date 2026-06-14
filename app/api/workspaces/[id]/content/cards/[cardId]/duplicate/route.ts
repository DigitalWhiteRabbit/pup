import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { duplicateCard } from "@/lib/services/content.service";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type Params = { params: { id: string; cardId: string } };

/** POST — дублировать карточку */
export async function POST(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "content",
    });

    const card = await duplicateCard(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(card, { status: 201 });
  });
}
