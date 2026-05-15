import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateVoiceSessionSummary } from "@/lib/services/voice-summary.service";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// GET — list participants, prune stale (>15s heartbeat)
// No auth required — guests can see participants
export async function GET(req: NextRequest, { params }: RouteParams) {
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

  // Check private room access
  const room = await db.voiceRoom.findUnique({
    where: { id: roomId },
    select: { isPrivate: true, allowedUserIds: true },
  });
  if (room?.isPrivate && !isGuest) {
    try {
      const allowed = JSON.parse(room.allowedUserIds) as string[];
      if (!allowed.includes(session!.user.id)) {
        return NextResponse.json(
          { error: "Нет доступа к приватному каналу" },
          { status: 403 },
        );
      }
    } catch {
      /* */
    }
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
  }

  // Update session participants list
  const activeSession = await db.voiceSession.findFirst({
    where: { roomId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (activeSession) {
    let pList: Array<{ userId?: string; login?: string; guestName?: string }> =
      [];
    try {
      pList = JSON.parse(activeSession.participants);
    } catch {
      /* */
    }
    const newEntry = isGuest
      ? { guestName: body.guestName }
      : {
          userId: session!.user.id,
          login: (session!.user as unknown as { login?: string }).login,
        };
    if (
      !pList.some((p) =>
        isGuest
          ? p.guestName === body.guestName
          : p.userId === session!.user.id,
      )
    ) {
      pList.push(newEntry);
      await db.voiceSession.update({
        where: { id: activeSession.id },
        data: { participants: JSON.stringify(pList) },
      });
    }
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
      // Generate AI summary in background
      void generateVoiceSessionSummary(activeSession.id);
    }
  }

  return NextResponse.json({ ok: true });
}
