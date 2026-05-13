import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { storage } from "@/lib/services/storage";

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const att = await db.chatMsgAttachment.findUnique({
      where: { id },
      include: { message: { select: { channelId: true } } },
    });
    if (!att)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });

    // Verify user has access to channel
    const membership = await db.chatChannelMember.findUnique({
      where: {
        channelId_userId: {
          channelId: att.message.channelId,
          userId: session.user.id,
        },
      },
    });
    if (!membership) {
      const ch = await db.chatChannel.findUnique({
        where: { id: att.message.channelId },
        select: { type: true },
      });
      if (!ch || (ch.type !== "PUBLIC" && ch.type !== "GENERAL"))
        return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
    }

    const stream = await storage().download(att.storagePath);
    const url = new URL(req.url);
    const forceDownload = url.searchParams.get("download") === "1";
    const disposition = forceDownload ? "attachment" : "inline";

    return new NextResponse(stream, {
      headers: {
        "Content-Type": att.mimeType,
        "Content-Disposition": `${disposition}; filename="${encodeURIComponent(att.originalName)}"`,
        "Content-Length": String(att.size),
      },
    });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
