import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { markAsRead, markAllAsRead } from "@/lib/services/notification.service";
import { z } from "zod";

const bodySchema = z.union([
  z.object({ notificationIds: z.array(z.string().min(1)).min(1) }),
  z.object({ all: z.literal(true) }),
]);

export async function POST(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const body = bodySchema.parse(await req.json());

    let result: { count: number };
    if ("all" in body) {
      result = await markAllAsRead(session.user.id);
    } else {
      result = await markAsRead(body.notificationIds, session.user.id);
    }

    return NextResponse.json(result);
  });
}
