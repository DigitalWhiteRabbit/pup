import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { assertChannelAccess } from "@/lib/services/chat-internal/channel-access";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type RouteParams = {
  params: Promise<{ id: string; channelId: string }>;
};

// GET — list pinned messages in a channel
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, channelId } = await params;
    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "chat",
    });
    // Was previously unauthenticated beyond session → leaked private-channel
    // pinned content. Enforce channel access.
    await assertChannelAccess(
      channelId,
      workspaceId,
      session.user.id,
      session.user.role,
    );

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
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
