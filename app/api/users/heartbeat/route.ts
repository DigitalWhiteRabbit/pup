import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

/** Gap threshold in milliseconds — if lastSeenAt was more than this ago, treat as new session segment */
const SESSION_GAP_MS = 10 * 60 * 1000; // 10 minutes

export async function POST(request: Request) {
  const session = await auth();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const now = new Date();

  // Update user's global lastSeenAt
  await db.user.update({
    where: { id: session.user.id },
    data: { lastSeenAt: now },
  });

  // Track per-workspace activity if workspaceId is provided
  let workspaceId: string | undefined;
  try {
    const body = (await request.json()) as { workspaceId?: string };
    workspaceId = body.workspaceId;
  } catch {
    // No body or invalid JSON — that's fine, just skip workspace tracking
  }

  if (workspaceId && typeof workspaceId === "string") {
    const todayStr = now.toISOString().slice(0, 10); // "2026-05-22"

    // Fetch existing record for today
    const existing = await db.memberActivity.findUnique({
      where: {
        userId_workspaceId_date: {
          userId: session.user.id,
          workspaceId,
          date: todayStr,
        },
      },
    });

    if (existing) {
      // Calculate if this is a continuation of existing session or a new segment
      const wasRecentlyActive =
        existing.lastSeenAt &&
        now.getTime() - existing.lastSeenAt.getTime() <= SESSION_GAP_MS;

      await db.memberActivity.update({
        where: { id: existing.id },
        data: {
          // Only add a minute if last seen was within the gap threshold (continuous session)
          minutesActive: wasRecentlyActive
            ? { increment: 1 }
            : existing.minutesActive,
          lastSeenAt: now,
          heartbeats: { increment: 1 },
        },
      });
    } else {
      // First heartbeat of the day for this user+workspace
      await db.memberActivity.create({
        data: {
          userId: session.user.id,
          workspaceId,
          date: todayStr,
          minutesActive: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          heartbeats: 1,
        },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
