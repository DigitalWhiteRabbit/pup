import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type RouteParams = {
  params: Promise<{ id: string; channelId: string }>;
};

// POST — toggle mute for current user
export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, channelId } = await params;

    try {
      await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
        module: "chat",
      });
    } catch (e) {
      if (e instanceof ApiError)
        return NextResponse.json(
          { error: e.message, code: e.code },
          { status: e.status },
        );
      throw e;
    }

    const membership = await db.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId: session.user.id } },
      select: { muted: true },
    });
    if (!membership)
      return NextResponse.json(
        { error: "Не участник канала" },
        { status: 403 },
      );

    const newMuted = !membership.muted;

    await db.chatChannelMember.update({
      where: { channelId_userId: { channelId, userId: session.user.id } },
      data: { muted: newMuted },
    });

    return NextResponse.json({ muted: newMuted });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
