import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { getUnreadCount } from "@/lib/services/notification.service";

export async function GET() {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const count = await getUnreadCount(session.user.id);
    return NextResponse.json({ count });
  });
}
