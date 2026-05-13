import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";
import { ApiError } from "@/lib/api-error";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId } = await params;

    const m = await checkMembership(workspaceId, session.user.id);
    if (!m && session.user.role !== "ADMIN")
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim();
    if (!q || q.length < 2) return NextResponse.json({ data: [] });

    const messages = await db.chatMsg.findMany({
      where: {
        channel: { workspaceId },
        content: { contains: q },
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        author: { select: { login: true } },
        channel: { select: { id: true, name: true, type: true } },
      },
    });

    return NextResponse.json({
      data: messages.map((m) => ({
        id: m.id,
        content: m.content.slice(0, 200),
        authorLogin: m.author.login,
        channelId: m.channel.id,
        channelName: m.channel.name ?? "ЛС",
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
