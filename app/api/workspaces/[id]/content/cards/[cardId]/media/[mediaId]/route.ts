import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { deleteMedia } from "@/lib/services/content.service";

type Params = {
  params: { id: string; cardId: string; mediaId: string };
};

/** DELETE — удалить медиа карточки */
export async function DELETE(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await deleteMedia(
      params.id,
      params.cardId,
      params.mediaId,
      session.user.id,
      session.user.role,
    );
    return new NextResponse(null, { status: 204 });
  });
}
