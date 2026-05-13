import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const sendSchema = z.object({
  content: z.string().min(1).max(10000),
  parentId: z.string().optional(),
});

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const before = url.searchParams.get("before") ?? undefined;
    const userId = session.user.id;

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
      take: 50,
      include: {
        author: { select: { id: true, login: true } },
        parent: {
          select: { content: true, author: { select: { login: true } } },
        },
        reactions: { select: { emoji: true, userId: true } },
      },
    });

    return NextResponse.json({
      data: msgs.reverse().map((m) => {
        const reactionMap = new Map<
          string,
          { count: number; myReaction: boolean }
        >();
        for (const r of m.reactions) {
          const ex = reactionMap.get(r.emoji);
          if (ex) {
            ex.count++;
            if (r.userId === userId) ex.myReaction = true;
          } else {
            reactionMap.set(r.emoji, {
              count: 1,
              myReaction: r.userId === userId,
            });
          }
        }
        return {
          id: m.id,
          authorId: m.author.id,
          authorLogin: m.author.login,
          content: m.content,
          parentId: m.parentId,
          editedAt: m.editedAt,
          createdAt: m.createdAt,
          replyTo: m.parent
            ? {
                authorLogin: m.parent.author.login,
                content: m.parent.content.slice(0, 100),
              }
            : null,
          reactions: Array.from(reactionMap.entries()).map(([emoji, data]) => ({
            emoji,
            ...data,
          })),
        };
      }),
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
    const { content, parentId } = sendSchema.parse(body);

    const msg = await db.globalChatMsg.create({
      data: {
        authorId: session.user.id,
        content,
        parentId: parentId ?? null,
      },
      include: { author: { select: { id: true, login: true } } },
    });

    return NextResponse.json(
      {
        id: msg.id,
        authorId: msg.author.id,
        authorLogin: msg.author.login,
        content: msg.content,
        parentId: msg.parentId,
        editedAt: null,
        createdAt: msg.createdAt,
        replyTo: null,
        reactions: [],
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
