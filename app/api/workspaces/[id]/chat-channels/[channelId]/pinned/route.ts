import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteParams = {
  params: Promise<{ id: string; channelId: string }>;
};

// GET — list pinned messages in a channel
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { channelId } = await params;

    const messages = await db.chatMsg.findMany({
      where: {
        channelId,
        pinnedAt: { not: null },
        deletedAt: null,
      },
      orderBy: { pinnedAt: "desc" },
      include: {
        author: { select: { id: true, login: true } },
        attachments: {
          select: { id: true, originalName: true, size: true, mimeType: true },
        },
      },
    });

    return NextResponse.json({
      data: messages.map((m) => ({
        id: m.id,
        authorId: m.author.id,
        authorLogin: m.author.login,
        content: m.content,
        pinnedAt: m.pinnedAt,
        pinnedById: m.pinnedById,
        createdAt: m.createdAt,
        attachments: m.attachments,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
