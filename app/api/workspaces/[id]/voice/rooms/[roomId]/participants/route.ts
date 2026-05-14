import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// GET — list participants, prune stale (>15s heartbeat)
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await params;

  // Prune stale participants
  const staleThreshold = new Date(Date.now() - 15_000);
  await db.voiceParticipant.deleteMany({
    where: { roomId, lastHeartbeat: { lt: staleThreshold } },
  });

  const participants = await db.voiceParticipant.findMany({
    where: { roomId },
    include: {
      user: { select: { id: true, login: true, avatarPath: true } },
    },
    orderBy: { joinedAt: "asc" },
  });

  return NextResponse.json(participants);
}

// POST — join room
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  const { roomId } = await params;

  const body = await req.json().catch(() => ({}));
  const isGuest = !session?.user?.id;

  if (isGuest && !body.guestName) {
    return NextResponse.json(
      { error: "guestName required for guests" },
      { status: 400 },
    );
  }

  // Prevent duplicate join
  const where = isGuest
    ? { roomId, guestToken: body.guestToken }
    : { roomId, userId: session!.user.id };

  const existing = await db.voiceParticipant.findFirst({ where });
  if (existing) {
    // Refresh heartbeat
    await db.voiceParticipant.update({
      where: { id: existing.id },
      data: { lastHeartbeat: new Date() },
    });
    return NextResponse.json(existing);
  }

  // If first participant, create VoiceSession
  const participantCount = await db.voiceParticipant.count({
    where: { roomId },
  });
  if (participantCount === 0) {
    const room = await db.voiceRoom.findUnique({ where: { id: roomId } });
    await db.voiceSession.create({
      data: {
        roomId,
        roomName: room?.name ?? "Unknown",
        workspaceId: room?.workspaceId ?? "",
        participants: "[]",
      },
    });
  } else {
    // No-op: session already exists
  }

  const participant = await db.voiceParticipant.create({
    data: {
      roomId,
      userId: isGuest ? undefined : session!.user.id,
      guestName: isGuest ? body.guestName : undefined,
      guestToken: isGuest ? body.guestToken : undefined,
      lastHeartbeat: new Date(),
    },
  });

  return NextResponse.json(participant, { status: 201 });
}

// DELETE — leave room
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  const { roomId } = await params;

  const body = await req.json().catch(() => ({}));
  const isGuest = !session?.user?.id;

  const where = isGuest
    ? { roomId, guestToken: body.guestToken }
    : { roomId, userId: session!.user.id };

  await db.voiceParticipant.deleteMany({ where });

  // If room now empty, close active session
  const remaining = await db.voiceParticipant.count({ where: { roomId } });
  if (remaining === 0) {
    const activeSession = await db.voiceSession.findFirst({
      where: { roomId, endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (activeSession) {
      const duration = Math.floor(
        (Date.now() - activeSession.startedAt.getTime()) / 1000,
      );
      await db.voiceSession.update({
        where: { id: activeSession.id },
        data: { endedAt: new Date(), duration },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
