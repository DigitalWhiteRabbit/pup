import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

type RouteParams = {
  params: Promise<{ id: string; channelId: string }>;
};

// POST — set typing indicator
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { channelId } = await params;

    await db.chatChannelMember.update({
      where: { channelId_userId: { channelId, userId: session.user.id } },
      data: { typingAt: new Date() },
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
