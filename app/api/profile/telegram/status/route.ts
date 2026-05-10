import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, apiError } from "@/lib/api-error";
import { db } from "@/lib/db";

export async function GET() {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      return apiError("Не авторизован", "UNAUTHORIZED", 401);

    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: {
        telegramChatId: true,
        tgNotifyAssign: true,
        tgNotifyComment: true,
        tgNotifyMove: true,
        tgNotifyProject: true,
        tgNotifyTaskDeleted: true,
        tgNotifyMemberRemoved: true,
        tgNotifyWorkspaceDeleted: true,
        tgNotifyRoleChanged: true,
      },
    });

    return NextResponse.json({
      connected: !!user?.telegramChatId,
      tgNotifyAssign: user?.tgNotifyAssign ?? true,
      tgNotifyComment: user?.tgNotifyComment ?? true,
      tgNotifyMove: user?.tgNotifyMove ?? true,
      tgNotifyProject: user?.tgNotifyProject ?? true,
      tgNotifyTaskDeleted: user?.tgNotifyTaskDeleted ?? false,
      tgNotifyMemberRemoved: user?.tgNotifyMemberRemoved ?? false,
      tgNotifyWorkspaceDeleted: user?.tgNotifyWorkspaceDeleted ?? false,
      tgNotifyRoleChanged: user?.tgNotifyRoleChanged ?? false,
    });
  });
}
