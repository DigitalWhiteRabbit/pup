import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const editSchema = z.object({ content: z.string().min(1).max(10000) });

type RouteParams = { params: Promise<{ messageId: string }> };

export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { messageId } = await params;
    const msg = await db.globalChatMsg.findUnique({
      where: { id: messageId },
      select: { authorId: true },
    });
    if (!msg)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    if (msg.authorId !== session.user.id)
      return NextResponse.json(
        { error: "Можно редактировать только свои сообщения" },
        { status: 403 },
      );

    const { content } = editSchema.parse(await req.json());
    await db.globalChatMsg.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { messageId } = await params;
    const msg = await db.globalChatMsg.findUnique({
      where: { id: messageId },
      select: { authorId: true },
    });
    if (!msg)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    if (msg.authorId !== session.user.id && session.user.role !== "ADMIN")
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    await db.globalChatMsg.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
