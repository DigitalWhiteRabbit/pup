import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { getChannelDetail } from "@/lib/services/chat-internal/channel.service";
import { broadcastToWorkspace } from "@/lib/services/chat-internal/sse.service";

type RouteParams = {
  params: Promise<{ id: string; channelId: string }>;
};

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});

// GET — channel detail
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { channelId } = await params;
    const detail = await getChannelDetail(channelId, session.user.id);
    return NextResponse.json({ data: detail });
  } catch (err) {
    if (err instanceof ApiError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

// PATCH — update channel name/description
export async function PATCH(req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, channelId } = await params;

    const channel = await db.chatChannel.findUnique({
      where: { id: channelId },
      select: { type: true },
    });
    if (!channel)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    if (channel.type === "DM")
      return NextResponse.json(
        { error: "Нельзя редактировать DM" },
        { status: 400 },
      );

    // Only members can update
    const membership = await db.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId: session.user.id } },
    });
    if (!membership && session.user.role !== "ADMIN")
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    const data = patchSchema.parse(await req.json());

    const updated = await db.chatChannel.update({
      where: { id: channelId },
      data,
      select: { id: true, name: true, description: true },
    });

    // SSE broadcast
    broadcastToWorkspace(workspaceId, {
      type: "channel_updated",
      data: { channelId, name: updated.name, description: updated.description },
    });

    return NextResponse.json({ data: updated });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

// DELETE — delete channel (not GENERAL, admin or creator only)
export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id: workspaceId, channelId } = await params;

    const channel = await db.chatChannel.findUnique({
      where: { id: channelId },
      select: { type: true, workspaceId: true },
    });
    if (!channel || channel.workspaceId !== workspaceId)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    if (channel.type === "GENERAL")
      return NextResponse.json(
        { error: "Нельзя удалить Общий канал" },
        { status: 400 },
      );

    // Only admin can delete
    if (session.user.role !== "ADMIN")
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    await db.chatChannel.delete({ where: { id: channelId } });

    // SSE broadcast
    broadcastToWorkspace(workspaceId, {
      type: "channel_deleted",
      data: { channelId },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}
