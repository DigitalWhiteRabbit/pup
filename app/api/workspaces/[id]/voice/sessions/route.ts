import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

type RouteParams = { params: Promise<{ id: string }> };

// GET — list past sessions, paginated
export async function GET(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: workspaceId } = await params;
  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));
  const limit = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "20")),
  );
  const skip = (page - 1) * limit;

  const [sessions, total] = await Promise.all([
    db.voiceSession.findMany({
      where: { workspaceId, endedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      skip,
      take: limit,
    }),
    db.voiceSession.count({ where: { workspaceId, endedAt: { not: null } } }),
  ]);

  return NextResponse.json({ sessions, total, page, limit });
}
