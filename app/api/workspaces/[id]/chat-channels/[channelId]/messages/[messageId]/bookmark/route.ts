import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { assertMessageChannelAccess } from "@/lib/services/chat-internal/channel-access";

type RouteParams = {
  params: Promise<{ id: string; channelId: string; messageId: string }>;
};

// POST — toggle bookmark
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, messageId } = await params;

    // Channel-level access (ws-scoped; PRIVATE/DM require membership).
    await assertMessageChannelAccess(
      messageId,
      workspaceId,
      session.user.id,
      session.user.role,
    );

    const existing = await db.chatMsgBookmark.findUnique({
      where: {
        messageId_userId: { messageId, userId: session.user.id },
      },
    });

    if (existing) {
      await db.chatMsgBookmark.delete({ where: { id: existing.id } });
      return NextResponse.json({ bookmarked: false });
    }

    await db.chatMsgBookmark.create({
      data: { messageId, userId: session.user.id },
    });
    return NextResponse.json({ bookmarked: true });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
