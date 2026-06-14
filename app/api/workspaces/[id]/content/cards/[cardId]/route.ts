import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import {
  getCard,
  updateCard,
  deleteCard,
} from "@/lib/services/content.service";
import { updateCardSchema } from "@/lib/schemas/content.schema";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type Params = { params: { id: string; cardId: string } };

/** GET — карточка целиком */
export async function GET(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "content",
    });

    const card = await getCard(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json(card);
  });
}

/** PATCH — редактирование (пополевой diff в истории) */
export async function PATCH(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "content",
    });

    const input = updateCardSchema.parse(await req.json());
    const card = await updateCard(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
      input,
    );
    return NextResponse.json(card);
  });
}

/** DELETE — удалить карточку */
export async function DELETE(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await requireWorkspaceAccess(accessCtxFromSession(session), params.id, {
      module: "content",
    });

    await deleteCard(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
    );
    return new NextResponse(null, { status: 204 });
  });
}
