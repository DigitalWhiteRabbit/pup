import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// PATCH /api/workspaces/[id]/voice/rooms/[roomId] — rename room
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await params;
  const body = await req.json();
  const name = body.name?.trim();

  if (!name)
    return NextResponse.json({ error: "Name is required" }, { status: 400 });

  const room = await db.voiceRoom.update({
    where: { id: roomId },
    data: { name },
  });

  return NextResponse.json(room);
}

// DELETE /api/workspaces/[id]/voice/rooms/[roomId] — delete room (not default)
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { roomId } = await params;

  const room = await db.voiceRoom.findUnique({ where: { id: roomId } });
  if (!room)
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  if (room.isDefault)
    return NextResponse.json(
      { error: "Cannot delete default room" },
      { status: 400 },
    );

  await db.voiceRoom.delete({ where: { id: roomId } });

  return NextResponse.json({ ok: true });
}
