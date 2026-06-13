import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  resolveVoiceAccess,
  loadRoomInWorkspace,
  assertRoomAllowed,
  voiceErrorResponse,
} from "@/lib/services/voice-access";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// GET — last 50 messages. Member OR guest with a valid invite token (?token=).
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { id: workspaceId, roomId } = await params;
    const inviteToken = new URL(req.url).searchParams.get("token");
    const access = await resolveVoiceAccess({
      session,
      workspaceId,
      roomId,
      inviteToken,
    });
    const room = await loadRoomInWorkspace(roomId, workspaceId);
    assertRoomAllowed(room, access);

    const messages = await db.voiceMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        user: { select: { id: true, login: true, avatarPath: true } },
      },
    });

    return NextResponse.json(messages.reverse());
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}

// POST — send message
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { id: workspaceId, roomId } = await params;
    const body = await req.json();

    const access = await resolveVoiceAccess({
      session,
      workspaceId,
      roomId,
      inviteToken: body.token,
    });
    const room = await loadRoomInWorkspace(roomId, workspaceId);
    assertRoomAllowed(room, access);

    const content = body.content?.trim();
    if (!content)
      return NextResponse.json({ error: "Content required" }, { status: 400 });

    const message = await db.voiceMessage.create({
      data: {
        roomId,
        userId: access.isGuest ? undefined : access.userId,
        guestName: access.isGuest ? body.guestName : undefined,
        content,
      },
      include: {
        user: { select: { id: true, login: true, avatarPath: true } },
      },
    });

    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
