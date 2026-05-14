import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { randomBytes } from "crypto";

type RouteParams = { params: Promise<{ id: string }> };

// POST — generate guest invite link
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const body = await req.json();
  const roomId = body.roomId;

  if (!roomId)
    return NextResponse.json({ error: "roomId required" }, { status: 400 });

  const token = randomBytes(24).toString("hex");
  const url = `/voice-join/${workspaceId}/${roomId}?token=${token}`;

  return NextResponse.json({ token, url });
}
