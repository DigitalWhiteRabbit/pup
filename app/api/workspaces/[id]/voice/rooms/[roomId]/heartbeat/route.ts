import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  resolveVoiceAccess,
  voiceErrorResponse,
} from "@/lib/services/voice-access";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// PATCH — update heartbeat + muted/screen state
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { id: workspaceId, roomId } = await params;
    const body = await req.json().catch(() => ({}));

    const access = await resolveVoiceAccess({
      session,
      workspaceId,
      roomId,
      inviteToken: body.token,
    });

    const where = access.isGuest
      ? { roomId, guestToken: body.guestToken }
      : { roomId, userId: access.userId };

    const participant = await db.voiceParticipant.findFirst({ where });
    if (!participant)
      return NextResponse.json({ error: "Not in room" }, { status: 404 });

    const updated = await db.voiceParticipant.update({
      where: { id: participant.id },
      data: {
        lastHeartbeat: new Date(),
        isMuted: body.isMuted ?? participant.isMuted,
        isScreenSharing: body.isScreenSharing ?? participant.isScreenSharing,
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
