import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { cardAction } from "@/lib/services/content.service";
import { notifyContentEvent } from "@/lib/services/content/notify";
import { actionSchema } from "@/lib/schemas/content.schema";

type Params = { params: { id: string; cardId: string } };

/** POST — действие воркфлоу: review | request-changes | approve | approve-visual | publish */
export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const { action, publishedUrl } = actionSchema.parse(await req.json());
    const result = await cardAction(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
      action,
      publishedUrl ? { publishedUrl } : undefined,
    );

    // Уведомления (бейдж + Telegram) — не блокируют ответ
    if (result.event) {
      void notifyContentEvent({
        workspaceId: params.id,
        actorId: session.user.id,
        cardId: result.event.cardId,
        authorId: result.event.authorId,
        kind: result.event.kind,
        title: result.card.title,
      });
    }

    return NextResponse.json(result.card);
  });
}
