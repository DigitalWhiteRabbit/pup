import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const sendSchema = z.object({
  content: z.string().min(1).max(10000),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const before = url.searchParams.get("before") ?? undefined;
    const limit = 50;

    const where: Record<string, unknown> = { deletedAt: null };
    if (before) {
      const bm = await db.globalChatMsg.findUnique({
        where: { id: before },
        select: { createdAt: true },
      });
      if (bm) where.createdAt = { lt: bm.createdAt };
    }

    const msgs = await db.globalChatMsg.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { author: { select: { id: true, login: true } } },
    });

    return NextResponse.json({
      data: msgs.reverse().map((m) => ({
        id: m.id,
        authorId: m.author.id,
        authorLogin: m.author.login,
        content: m.content,
        editedAt: m.editedAt,
        createdAt: m.createdAt,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body: unknown = await req.json();
    const { content } = sendSchema.parse(body);

    const msg = await db.globalChatMsg.create({
      data: { authorId: session.user.id, content },
      include: { author: { select: { id: true, login: true } } },
    });

    return NextResponse.json(
      {
        id: msg.id,
        authorId: msg.author.id,
        authorLogin: msg.author.login,
        content: msg.content,
        editedAt: null,
        createdAt: msg.createdAt,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
