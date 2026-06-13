import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  assertMember,
  loadRoomInWorkspace,
  voiceErrorResponse,
} from "@/lib/services/voice-access";

type RouteParams = { params: Promise<{ id: string; roomId: string }> };

// PATCH /api/workspaces/[id]/voice/rooms/[roomId] — rename room
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, roomId } = await params;
    await assertMember(workspaceId, session.user.id, session.user.role);
    // Scope to workspace (prevents renaming another workspace's room by id).
    await loadRoomInWorkspace(roomId, workspaceId);

    const body = await req.json();
    const name = body.name?.trim();
    if (!name)
      return NextResponse.json({ error: "Name is required" }, { status: 400 });

    const room = await db.voiceRoom.update({
      where: { id: roomId },
      data: { name },
    });

    return NextResponse.json(room);
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}

// DELETE /api/workspaces/[id]/voice/rooms/[roomId] — delete room (not default)
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId, roomId } = await params;
    await assertMember(workspaceId, session.user.id, session.user.role);
    // Scope to workspace (prevents deleting another workspace's room by id).
    const room = await loadRoomInWorkspace(roomId, workspaceId);

    if (room.isDefault)
      return NextResponse.json(
        { error: "Cannot delete default room" },
        { status: 400 },
      );

    await db.voiceRoom.delete({ where: { id: roomId } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
