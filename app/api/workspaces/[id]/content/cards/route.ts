import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { NextRequest, NextResponse } from "next/server";
import { listCards, createCard } from "@/lib/services/content.service";
import {
  createCardSchema,
  listFilterSchema,
} from "@/lib/schemas/content.schema";

type Params = { params: { id: string } };

/** GET — список карточек с фильтрами */
export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const raw = Object.fromEntries(req.nextUrl.searchParams);
    const filter = listFilterSchema.parse(raw);

    const cards = await listCards(
      params.id,
      session.user.id,
      session.user.role,
      filter,
    );
    return NextResponse.json({ data: cards, total: cards.length });
  });
}

/** POST — создать карточку */
export async function POST(req: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const input = createCardSchema.parse(await req.json());
    const card = await createCard(
      params.id,
      session.user.id,
      session.user.role,
      input,
    );
    return NextResponse.json(card, { status: 201 });
  });
}
