import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { getNotificationsSchema } from "@/lib/schemas/notification.schema";
import { getNotifications } from "@/lib/services/notification.service";

export async function GET(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const params = Object.fromEntries(req.nextUrl.searchParams);
    const input = getNotificationsSchema.parse(params);

    const result = await getNotifications(session.user.id, {
      unreadOnly: input.unreadOnly,
      page: input.page,
      limit: input.limit,
    });

    return NextResponse.json(result);
  });
}
