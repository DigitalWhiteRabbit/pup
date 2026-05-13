import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteParams = {
  params: Promise<{ id: string; channelId: string; messageId: string }>;
};

// POST — toggle pin on a message
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { channelId, messageId } = await params;

    const msg = await db.chatMsg.findUnique({
      where: { id: messageId },
      select: { channelId: true, pinnedAt: true },
    });
    if (!msg || msg.channelId !== channelId)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });

    // Verify membership
    const membership = await db.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId: session.user.id } },
    });
    if (!membership)
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    const isPinned = !!msg.pinnedAt;

    await db.chatMsg.update({
      where: { id: messageId },
      data: isPinned
        ? { pinnedAt: null, pinnedById: null }
        : { pinnedAt: new Date(), pinnedById: session.user.id },
    });

    return NextResponse.json({ pinned: !isPinned });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
