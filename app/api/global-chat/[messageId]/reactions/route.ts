import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const schema = z.object({ emoji: z.string().min(1).max(8) });

type RouteParams = { params: Promise<{ messageId: string }> };

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { messageId } = await params;
    const { emoji } = schema.parse(await req.json());

    const existing = await db.globalChatReaction.findUnique({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId: session.user.id,
          emoji,
        },
      },
    });

    if (existing) {
      await db.globalChatReaction.delete({ where: { id: existing.id } });
      return NextResponse.json({ added: false });
    }

    await db.globalChatReaction.create({
      data: { messageId, userId: session.user.id, emoji },
    });
    return NextResponse.json({ added: true });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
