import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// GET — poll unconsumed signals for current user, mark consumed, clean old
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await params;
  const userId = session.user.id;

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

  // Clean up old consumed signals (>1 hour)
  const oneHourAgo = new Date(Date.now() - 3_600_000);
  await db.voiceSignal.deleteMany({
    where: { roomId, consumedAt: { not: null, lt: oneHourAgo } },
  });

  return NextResponse.json(signals);
}

// POST — send signal
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await params;
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
}
