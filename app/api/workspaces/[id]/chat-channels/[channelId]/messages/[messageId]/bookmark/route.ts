import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteParams = {
  params: Promise<{ id: string; channelId: string; messageId: string }>;
};

// POST — toggle bookmark
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { messageId } = await params;

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
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
