import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";
import { z } from "zod";
import { shiftCardDate } from "@/lib/services/content.service";

type Params = { params: { id: string; cardId: string } };

const schema = z.object({ delta: z.number().int().min(-31).max(31) });

/** POST — сдвиг даты публикации (±1 день и т.п.) */
export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const { delta } = schema.parse(await req.json());
    const card = await shiftCardDate(
      params.id,
      params.cardId,
      session.user.id,
      session.user.role,
      delta,
    );
    return NextResponse.json(card);
  });
}
