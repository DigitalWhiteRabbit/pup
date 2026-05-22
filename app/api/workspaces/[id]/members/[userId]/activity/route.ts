import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { checkMembership } from "@/lib/services/member.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string; userId: string } };

export async function GET(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const workspaceId = params.id;
    const memberId = params.userId;

    // Check requester is OWNER or ADMIN (only owners/admins can view member activity)
    const role = await checkMembership(workspaceId, session.user.id);
    if (role !== "OWNER" && session.user.role !== "ADMIN") {
      throw new ApiError(
        "Только владелец или администратор может просматривать активность",
        "FORBIDDEN",
        403,
      );
    }

    // Verify target member exists in workspace
    const targetMembership = await db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: memberId } },
      include: {
        user: { select: { id: true, login: true, email: true } },
      },
    });

    if (!targetMembership) {
      // Also check if member is the workspace owner
      const workspace = await db.workspace.findUnique({
        where: { id: workspaceId },
        select: { ownerId: true },
      });
      if (workspace?.ownerId !== memberId) {
        throw new ApiError("Участник не найден", "MEMBER_NOT_FOUND", 404);
      }
    }

    // Parse query params
    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? "week";
    const dateParam = url.searchParams.get("date");
    const baseDate = dateParam ? new Date(dateParam) : new Date();

    // Calculate date range based on period
    let startDate: Date;
    let endDate: Date;
    let dayCount: number;

    switch (period) {
      case "day": {
        startDate = new Date(baseDate);
        endDate = new Date(baseDate);
        dayCount = 1;
        break;
      }
      case "month": {
        startDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
        endDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0);
        dayCount = endDate.getDate();
        break;
      }
      case "week":
      default: {
        // Last 7 days ending on baseDate
        endDate = new Date(baseDate);
        startDate = new Date(baseDate);
        startDate.setDate(startDate.getDate() - 6);
        dayCount = 7;
        break;
      }
    }

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    // Fetch activity records
    const activities = await db.memberActivity.findMany({
      where: {
        userId: memberId,
        workspaceId,
        date: { gte: startStr, lte: endStr },
      },
      orderBy: { date: "asc" },
    });

    // Build a map for quick lookup
    const activityMap = new Map(activities.map((a) => [a.date, a]));

    // Generate all dates in range with data (fill in zeros for missing days)
    const data: Array<{
      date: string;
      minutesActive: number;
      heartbeats: number;
      firstSeen: string | null;
      lastSeen: string | null;
    }> = [];

    const cursor = new Date(startDate);
    for (let i = 0; i < dayCount; i++) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const activity = activityMap.get(dateStr);

      data.push({
        date: dateStr,
        minutesActive: activity?.minutesActive ?? 0,
        heartbeats: activity?.heartbeats ?? 0,
        firstSeen: activity?.firstSeenAt
          ? activity.firstSeenAt.toISOString().slice(11, 16)
          : null,
        lastSeen: activity?.lastSeenAt
          ? activity.lastSeenAt.toISOString().slice(11, 16)
          : null,
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    // Summary
    const totalMinutes = data.reduce((sum, d) => sum + d.minutesActive, 0);
    const daysActive = data.filter((d) => d.minutesActive > 0).length;
    const avgMinutesPerDay =
      daysActive > 0 ? Math.round(totalMinutes / daysActive) : 0;

    // Get member info
    const member = targetMembership
      ? {
          id: targetMembership.user.id,
          login: targetMembership.user.login,
          role: targetMembership.role,
        }
      : await db.user
          .findUnique({
            where: { id: memberId },
            select: { id: true, login: true },
          })
          .then((u) =>
            u ? { id: u.id, login: u.login, role: "OWNER" } : null,
          );

    return NextResponse.json({
      member,
      period,
      data,
      summary: {
        totalMinutes,
        avgMinutesPerDay,
        daysActive,
      },
    });
  });
}
