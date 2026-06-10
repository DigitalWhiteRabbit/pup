import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

export async function GET(request: Request, { params }: Params) {
  try {
    const session = await auth();
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const workspaceId = params.id;

    // Authorization: OWNER or ADMIN only
    const membership = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
      select: { role: true },
    });
    if (membership?.role !== "OWNER" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? "week";
    const dateParam = url.searchParams.get("date");
    const baseDate = dateParam ? new Date(dateParam) : new Date();

    let startStr: string;
    let endStr: string;

    switch (period) {
      case "day": {
        startStr = baseDate.toISOString().slice(0, 10);
        endStr = startStr;
        break;
      }
      case "month": {
        const monthStart = new Date(
          baseDate.getFullYear(),
          baseDate.getMonth(),
          1,
        );
        const monthEnd = new Date(
          baseDate.getFullYear(),
          baseDate.getMonth() + 1,
          0,
        );
        startStr = monthStart.toISOString().slice(0, 10);
        endStr = monthEnd.toISOString().slice(0, 10);
        break;
      }
      default: {
        const weekStart = new Date(baseDate);
        weekStart.setDate(weekStart.getDate() - 6);
        startStr = weekStart.toISOString().slice(0, 10);
        endStr = baseDate.toISOString().slice(0, 10);
        break;
      }
    }

    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        ownerId: true,
        owner: { select: { id: true, login: true } },
        members: {
          include: {
            user: { select: { id: true, login: true, lastSeenAt: true } },
          },
        },
      },
    });
    if (!workspace)
      return NextResponse.json({ error: "Not found" }, { status: 404 });

    const activities = await db.memberActivity.findMany({
      where: { workspaceId, date: { gte: startStr, lte: endStr } },
    });

    const activityByUser = new Map<
      string,
      { totalMinutes: number; daysActive: number; lastSeen: Date | null }
    >();
    for (const a of activities) {
      const existing = activityByUser.get(a.userId);
      if (existing) {
        existing.totalMinutes += a.minutesActive;
        if (a.minutesActive > 0) existing.daysActive += 1;
        if (
          a.lastSeenAt &&
          (!existing.lastSeen || a.lastSeenAt > existing.lastSeen)
        )
          existing.lastSeen = a.lastSeenAt;
      } else {
        activityByUser.set(a.userId, {
          totalMinutes: a.minutesActive,
          daysActive: a.minutesActive > 0 ? 1 : 0,
          lastSeen: a.lastSeenAt,
        });
      }
    }

    const members = workspace.members.map((m) => ({
      id: m.user.id,
      login: m.user.login,
      role: m.role,
      lastSeenAt: m.user.lastSeenAt?.toISOString() ?? null,
      totalMinutes: activityByUser.get(m.user.id)?.totalMinutes ?? 0,
      daysActive: activityByUser.get(m.user.id)?.daysActive ?? 0,
    }));

    members.sort((a, b) => b.totalMinutes - a.totalMinutes);

    return NextResponse.json({
      period,
      startDate: startStr,
      endDate: endStr,
      members,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
