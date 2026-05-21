import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { broadcastToOthers } from "@/lib/services/chat-internal/sse.service";

type RouteParams = {
  params: Promise<{ id: string; channelId: string }>;
};

// POST — set typing indicator
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, channelId } = await params;

    const membership = await db.chatChannelMember.update({
      where: { channelId_userId: { channelId, userId: session.user.id } },
      data: { typingAt: new Date() },
      include: { user: { select: { login: true } } },
    });

    // SSE broadcast to everyone except the typer
    broadcastToOthers(workspaceId, session.user.id, {
      type: "typing",
      data: {
        channelId,
        userId: session.user.id,
        login: membership.user.login,
      },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

// GET — list users currently typing (within last 5s), excluding current user
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { channelId } = await params;

    const fiveSecondsAgo = new Date(Date.now() - 5000);

    const typing = await db.chatChannelMember.findMany({
      where: {
        channelId,
        userId: { not: session.user.id },
        typingAt: { gt: fiveSecondsAgo },
      },
      select: {
        user: { select: { id: true, login: true } },
      },
    });

    return NextResponse.json({
      data: typing.map((t) => ({
        userId: t.user.id,
        login: t.user.login,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
