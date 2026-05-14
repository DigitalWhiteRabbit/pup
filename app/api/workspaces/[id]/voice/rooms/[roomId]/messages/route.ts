import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// GET — last 50 messages
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await params;

  const messages = await db.voiceMessage.findMany({
    where: { roomId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      user: { select: { id: true, login: true, avatarPath: true } },
    },
  });

  return NextResponse.json(messages.reverse());
}

// POST — send message
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  const { roomId } = await params;
  const body = await req.json();

  const content = body.content?.trim();
  if (!content)
    return NextResponse.json({ error: "Content required" }, { status: 400 });

  const isGuest = !session?.user?.id;

  const message = await db.voiceMessage.create({
    data: {
      roomId,
      userId: isGuest ? undefined : session!.user.id,
      guestName: isGuest ? body.guestName : undefined,
      content,
    },
    include: {
      user: { select: { id: true, login: true, avatarPath: true } },
    },
  });

  return NextResponse.json(message, { status: 201 });
}
