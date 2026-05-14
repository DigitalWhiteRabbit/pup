import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/workspaces/[id]/voice/rooms — list voice rooms
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;

  const rooms = await db.voiceRoom.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: {
      _count: { select: { participants: true } },
    },
  });

  return NextResponse.json(rooms);
}

// POST /api/workspaces/[id]/voice/rooms — create room
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const body = await req.json();
  const name = body.name?.trim();

  if (!name)
    return NextResponse.json({ error: "Name is required" }, { status: 400 });

  // Auto-create default room if none exist
  const count = await db.voiceRoom.count({ where: { workspaceId } });
  if (count === 0) {
    await db.voiceRoom.create({
      data: { workspaceId, name: "Общая", isDefault: true },
    });
  }

  const room = await db.voiceRoom.create({
    data: { workspaceId, name, isDefault: false },
  });

  return NextResponse.json(room, { status: 201 });
}
