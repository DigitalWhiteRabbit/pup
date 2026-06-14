import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { broadcastToChannelMembers } from "@/lib/services/chat-internal/sse.service";
import {
  assertChannelAccess,
  resolveChannelDelivery,
} from "@/lib/services/chat-internal/channel-access";

type RouteParams = {
  params: Promise<{ id: string; channelId: string; messageId: string }>;
};

// POST — toggle pin on a message
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, channelId, messageId } = await params;

    // Channel-level access (ws-scoped; PRIVATE/DM require membership).
    await assertChannelAccess(
      channelId,
      workspaceId,
      session.user.id,
      session.user.role,
    );

    const msg = await db.chatMsg.findUnique({
      where: { id: messageId },
      select: { channelId: true, pinnedAt: true },
    });
    if (!msg || msg.channelId !== channelId)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });

    const isPinned = !!msg.pinnedAt;

    await db.chatMsg.update({
      where: { id: messageId },
      data: isPinned
        ? { pinnedAt: null, pinnedById: null }
        : { pinnedAt: new Date(), pinnedById: session.user.id },
    });

    // SSE — scoped to channel members (don't leak private-channel pin events).
    const d = await resolveChannelDelivery(channelId);
    if (d)
      broadcastToChannelMembers(d.workspaceId, d.recipients, {
        type: "message_pinned",
        data: { channelId, messageId, pinned: !isPinned },
      });

    return NextResponse.json({ pinned: !isPinned });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
