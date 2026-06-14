import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { sendMessage } from "@/lib/services/chat-internal/message.service";
import { assertChannelAccess } from "@/lib/services/chat-internal/channel-access";
import { ApiError } from "@/lib/api-error";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

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

    const { id: workspaceId, channelId, messageId } = await params;

    await requireWorkspaceAccess(accessCtxFromSession(session), workspaceId, {
      module: "chat",
    });

    const body: unknown = await req.json();
    const { targetChannelId } = forwardSchema.parse(body);

    // Access to SOURCE channel (ws-scoped; PRIVATE/DM require membership).
    await assertChannelAccess(
      channelId,
      workspaceId,
      session.user.id,
      session.user.role,
    );

    // Get original message
    const original = await db.chatMsg.findUnique({
      where: { id: messageId },
      select: { content: true, deletedAt: true, channelId: true },
    });
    if (original && original.channelId !== channelId)
      return NextResponse.json(
        { error: "Сообщение не в этом канале" },
        { status: 400 },
      );
    if (!original || original.deletedAt)
      return NextResponse.json(
        { error: "Сообщение не найдено" },
        { status: 404 },
      );

    // Target channel access (incl. cross-ws) is enforced inside sendMessage.
    const msg = await sendMessage(
      targetChannelId,
      session.user.id,
      workspaceId,
      { content: original.content, forwardedFromId: messageId },
      session.user.role,
    );

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
