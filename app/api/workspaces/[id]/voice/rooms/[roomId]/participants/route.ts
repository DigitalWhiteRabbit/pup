import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { generateVoiceSessionSummary } from "@/lib/services/voice-summary.service";
import {
  resolveVoiceAccess,
  loadRoomInWorkspace,
  assertRoomAllowed,
  voiceErrorResponse,
} from "@/lib/services/voice-access";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// GET — list participants, prune stale. Member (by membership) OR guest with a
// valid invite token (?token=) — was previously fully unauthenticated (leaked
// private-room rosters to anyone).
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
    assertRoomAllowed(room, access); // members must be on a private room's allow-list

    // Prune stale participants
    const staleThreshold = new Date(Date.now() - 30_000);
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
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}

// POST — join room
export async function POST(req: NextRequest, { params }: RouteParams) {
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
    const isGuest = access.isGuest;
    const room = await loadRoomInWorkspace(roomId, workspaceId);

    if (isGuest && !body.guestName) {
      return NextResponse.json(
        { error: "guestName required for guests" },
        { status: 400 },
      );
    }

    // Private-room allow-list for MEMBERS (guests are admitted by invite token).
    assertRoomAllowed(room, access);

    const userId = access.isGuest ? undefined : access.userId;

    // Prevent duplicate join
    const where = isGuest
      ? { roomId, guestToken: body.guestToken }
      : { roomId, userId };

    const existing = await db.voiceParticipant.findFirst({ where });
    if (existing) {
      await db.voiceParticipant.update({
        where: { id: existing.id },
        data: { lastHeartbeat: new Date() },
      });
      return NextResponse.json(existing);
    }

    // Ensure active VoiceSession exists (create if none)
    const existingSession = await db.voiceSession.findFirst({
      where: { roomId, endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (!existingSession) {
      await db.voiceSession.create({
        data: {
          roomId,
          roomName: room.name,
          workspaceId,
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
      let pList: Array<{
        userId?: string;
        login?: string;
        guestName?: string;
      }> = [];
      try {
        pList = JSON.parse(activeSession.participants);
      } catch {
        /* */
      }
      const newEntry = isGuest
        ? { guestName: body.guestName }
        : {
            userId,
            login: (session!.user as unknown as { login?: string }).login,
          };
      if (
        !pList.some((p) =>
          isGuest ? p.guestName === body.guestName : p.userId === userId,
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
        userId: isGuest ? undefined : userId,
        guestName: isGuest ? body.guestName : undefined,
        guestToken: isGuest ? body.guestToken : undefined,
        lastHeartbeat: new Date(),
      },
    });

    return NextResponse.json(participant, { status: 201 });
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}

// DELETE — leave room
export async function DELETE(req: NextRequest, { params }: RouteParams) {
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
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
