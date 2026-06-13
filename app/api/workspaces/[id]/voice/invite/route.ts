import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  assertMember,
  loadRoomInWorkspace,
  assertRoomAllowed,
  voiceErrorResponse,
} from "@/lib/services/voice-access";
import { createVoiceInvite } from "@/lib/services/voice-invite";

type RouteParams = { params: Promise<{ id: string }> };

// POST — generate a signed, expiring guest invite link bound to (workspace, room)
export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: workspaceId } = await params;
    await assertMember(workspaceId, session.user.id, session.user.role);

    const body = await req.json();
    const roomId = body.roomId;
    if (!roomId)
      return NextResponse.json({ error: "roomId required" }, { status: 400 });

    // Room must belong to this workspace, and the issuing member must be
    // allowed in it (can't mint a guest link to a private room you can't enter).
    const room = await loadRoomInWorkspace(roomId, workspaceId);
    assertRoomAllowed(room, {
      isGuest: false,
      userId: session.user.id,
      role: session.user.role ?? "USER",
    });

    // Signed token (HMAC, 24h) — verified server-side on guest join; not stored.
    const token = createVoiceInvite(workspaceId, roomId);
    const url = `/voice-join/${workspaceId}/${roomId}?token=${token}`;

    return NextResponse.json({ token, url });
  } catch (err) {
    const { status, body } = voiceErrorResponse(err);
    return NextResponse.json(body, { status });
  }
}
