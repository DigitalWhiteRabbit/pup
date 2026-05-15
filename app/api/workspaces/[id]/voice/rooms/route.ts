import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string }> };

// GET — list rooms (filter private rooms user can't access)
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const userId = session.user.id;

  // Auto-create default room
  const count = await db.voiceRoom.count({ where: { workspaceId } });
  if (count === 0) {
    await db.voiceRoom.create({
      data: { workspaceId, name: "Общая", isDefault: true },
    });
  }

  const rooms = await db.voiceRoom.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { _count: { select: { participants: true } } },
  });

  // Filter: show all public rooms + private rooms where user is allowed
  const visible = rooms.filter((r) => {
    if (!r.isPrivate) return true;
    try {
      const allowed = JSON.parse(r.allowedUserIds) as string[];
      return allowed.includes(userId);
    } catch {
      return false;
    }
  });

  return NextResponse.json(
    visible.map((r) => ({
      id: r.id,
      name: r.name,
      isDefault: r.isDefault,
      isPrivate: r.isPrivate,
      participantCount: r._count.participants,
    })),
  );
}

// POST — create room (with optional private + allowed users)
export async function POST(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const body = await req.json();
  const name = body.name?.trim();
  const isPrivate = !!body.isPrivate;
  const allowedUserIds: string[] = Array.isArray(body.allowedUserIds)
    ? body.allowedUserIds
    : [];

  if (!name)
    return NextResponse.json({ error: "Name is required" }, { status: 400 });

  // Always include creator in allowed list for private rooms
  if (isPrivate && !allowedUserIds.includes(session.user.id)) {
    allowedUserIds.push(session.user.id);
  }

  const room = await db.voiceRoom.create({
    data: {
      workspaceId,
      name,
      isDefault: false,
      isPrivate,
      allowedUserIds: JSON.stringify(allowedUserIds),
    },
  });

  return NextResponse.json(room, { status: 201 });
}
