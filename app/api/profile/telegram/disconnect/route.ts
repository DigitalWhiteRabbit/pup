import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { db } from "@/lib/db";

export async function POST() {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    await db.user.update({
      where: { id: session.user.id },
      data: { telegramChatId: null },
    });

    return NextResponse.json({ ok: true });
  });
}
