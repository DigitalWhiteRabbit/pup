import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { sendMessage } from "@/lib/services/chat-internal/message.service";
import { ApiError } from "@/lib/api-error";

const forwardSchema = z.object({
  targetChannelId: z.string().min(1),
});

type RouteParams = {
  params: Promise<{ id: string; channelId: string; messageId: string }>;
};

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { messageId } = await params;
    const body: unknown = await req.json();
    const { targetChannelId } = forwardSchema.parse(body);

    // Get original message
    const original = await db.chatMsg.findUnique({
      where: { id: messageId },
      select: { content: true, deletedAt: true },
    });
    if (!original || original.deletedAt)
      return NextResponse.json(
        { error: "Сообщение не найдено" },
        { status: 404 },
      );

    const msg = await sendMessage(targetChannelId, session.user.id, {
      content: original.content,
      forwardedFromId: messageId,
    });

    return NextResponse.json(msg, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
