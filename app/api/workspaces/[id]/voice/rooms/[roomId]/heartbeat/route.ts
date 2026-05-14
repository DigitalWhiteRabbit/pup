import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// PATCH — update heartbeat + muted/screen state
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  const { roomId } = await params;
  const body = await req.json().catch(() => ({}));

  const isGuest = !session?.user?.id;
  const where = isGuest
    ? { roomId, guestToken: body.guestToken }
    : { roomId, userId: session!.user.id };

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
}
