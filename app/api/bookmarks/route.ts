import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET — list all bookmarked messages for current user
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const bookmarks = await db.chatMsgBookmark.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: {
        message: {
          include: {
            author: { select: { id: true, login: true } },
            channel: {
              select: { id: true, name: true, type: true, workspaceId: true },
            },
            attachments: {
              select: {
                id: true,
                originalName: true,
                size: true,
                mimeType: true,
              },
            },
          },
        },
      },
    });

    // Filter out deleted messages
    const data = bookmarks
      .filter((b) => !b.message.deletedAt)
      .map((b) => ({
        bookmarkId: b.id,
        bookmarkedAt: b.createdAt,
        message: {
          id: b.message.id,
          authorId: b.message.author.id,
          authorLogin: b.message.author.login,
          content: b.message.content,
          createdAt: b.message.createdAt,
          channelId: b.message.channel.id,
          channelName: b.message.channel.name,
          channelType: b.message.channel.type,
          workspaceId: b.message.channel.workspaceId,
          attachments: b.message.attachments,
        },
      }));

    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
