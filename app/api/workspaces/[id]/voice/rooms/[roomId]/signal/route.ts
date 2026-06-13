import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  assertMember,
  loadRoomInWorkspace,
  voiceErrorResponse,
} from "@/lib/services/voice-access";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// GET — poll unconsumed signals for current user, mark consumed, clean old
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, roomId } = await params;
    const userId = session.user.id;
    await assertMember(workspaceId, userId, session.user.role);
    await loadRoomInWorkspace(roomId, workspaceId);

    const signals = await db.voiceSignal.findMany({
      where: { roomId, toUserId: userId, consumedAt: null },
      orderBy: { createdAt: "asc" },
    });

    // Mark consumed
    if (signals.length > 0) {
      await db.voiceSignal.updateMany({
        where: { id: { in: signals.map((s) => s.id) } },
        data: { consumedAt: new Date() },
      });
    }

    // Clean up old consumed signals (>1 hour) — probabilistic to avoid writes per poll
    if (Math.random() < 0.05) {
      const oneHourAgo = new Date(Date.now() - 3_600_000);
      await db.voiceSignal.deleteMany({
        where: { roomId, consumedAt: { not: null, lt: oneHourAgo } },
      });
    }

    return NextResponse.json(signals);
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}

// POST — send signal
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, roomId } = await params;
    await assertMember(workspaceId, session.user.id, session.user.role);
    await loadRoomInWorkspace(roomId, workspaceId);

    const body = await req.json();

    if (!body.toUserId || !body.type || !body.payload) {
      return NextResponse.json(
        { error: "toUserId, type, payload required" },
        { status: 400 },
      );
    }

    const signal = await db.voiceSignal.create({
      data: {
        roomId,
        fromUserId: session.user.id,
        toUserId: body.toUserId,
        type: body.type,
        payload: body.payload,
      },
    });

    return NextResponse.json(signal, { status: 201 });
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
