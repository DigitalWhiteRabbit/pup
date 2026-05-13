import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { toggleReaction } from "@/lib/services/chat-internal/message.service";
import { db } from "@/lib/db";

const schema = z.object({ emoji: z.string().min(1).max(10) });

export async function POST(
  req: Request,
  {
    params,
  }: { params: Promise<{ id: string; channelId: string; messageId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { channelId, messageId } = await params;
    // Verify channel access
    const membership = await db.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId: session.user.id } },
    });
    if (!membership) {
      const ch = await db.chatChannel.findUnique({
        where: { id: channelId },
        select: { type: true },
      });
      if (!ch || (ch.type !== "PUBLIC" && ch.type !== "GENERAL"))
        return NextResponse.json({ error: "Нет доступа" }, { status: 403 });
    }
    const { emoji } = schema.parse(await req.json());
    const result = await toggleReaction(messageId, session.user.id, emoji);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
