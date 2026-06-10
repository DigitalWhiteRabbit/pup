import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { getHistory } from "@/lib/services/content.service";

type Params = { params: { id: string; cardId: string } };

/** GET — лента истории правок карточки */
export async function GET(_req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const history = await getHistory(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
    );
    return NextResponse.json({ data: history });
  });
}
