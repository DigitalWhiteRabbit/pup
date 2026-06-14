import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import {
  requireWorkspaceAccess,
  accessCtxFromSession,
} from "@/lib/services/workspace-access";

type RouteParams = {
  params: Promise<{ id: string; channelId: string }>;
};

const addSchema = z.object({ userId: z.string().min(1) });
const removeSchema = z.object({ userId: z.string().min(1) });

// POST — add member to channel
export async function POST(req: Request, { params }: RouteParams) {
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

    const channel = await db.chatChannel.findUnique({
      where: { id: channelId },
      select: { type: true, workspaceId: true },
    });
    if (!channel || channel.workspaceId !== workspaceId)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });

    // Verify requester is a member
    const requesterMembership = await db.chatChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId: session.user.id } },
    });
    if (!requesterMembership)
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    const { userId } = addSchema.parse(await req.json());

    // Verify target is a workspace member
    const wsMember = await db.workspaceMember.findFirst({
      where: { workspaceId, userId },
    });
    if (!wsMember)
      return NextResponse.json(
        { error: "Пользователь не в рабочем пространстве" },
        { status: 400 },
      );

    await db.chatChannelMember.upsert({
      where: { channelId_userId: { channelId, userId } },
      create: { channelId, userId },
      update: {},
    });

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError)
      return NextResponse.json(
        { error: err.errors[0]?.message },
        { status: 400 },
      );
    return NextResponse.json({ error: "Ошибка" }, { status: 500 });
  }
}

// DELETE — remove member from channel (not GENERAL)
export async function DELETE(req: Request, { params }: RouteParams) {
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

    const channel = await db.chatChannel.findUnique({
      where: { id: channelId },
      select: { type: true },
    });
    if (!channel)
      return NextResponse.json({ error: "Не найдено" }, { status: 404 });
    if (channel.type === "GENERAL")
      return NextResponse.json(
        { error: "Нельзя удалить участника из Общего канала" },
        { status: 400 },
      );

    const { userId } = removeSchema.parse(await req.json());

    // Only allow self-removal or admin
    if (userId !== session.user.id && session.user.role !== "ADMIN")
      return NextResponse.json({ error: "Нет доступа" }, { status: 403 });

    await db.chatChannelMember.deleteMany({
      where: { channelId, userId },
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
