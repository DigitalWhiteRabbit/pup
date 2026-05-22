import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { checkMembership } from "@/lib/services/member.service";
import { NextResponse } from "next/server";

type Params = { params: { id: string } };

/**
 * GET /api/workspaces/[id]/members/activity?period=week&date=2026-05-22
 *
 * Returns activity summary for all workspace members.
 * Only accessible by workspace OWNER or system ADMIN.
 */
export async function GET(request: Request, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const workspaceId = params.id;

    // Authorization: OWNER or ADMIN only
    const role = await checkMembership(workspaceId, session.user.id);
    if (role !== "OWNER" && session.user.role !== "ADMIN") {
      throw new ApiError(
        "Только владелец или администратор может просматривать активность",
        "FORBIDDEN",
        403,
      );
    }

    // Parse query params
    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? "week";
    const dateParam = url.searchParams.get("date");
    const baseDate = dateParam ? new Date(dateParam) : new Date();

    // Calculate date range
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
      case "week":
      default: {
        const weekEnd = new Date(baseDate);
        const weekStart = new Date(baseDate);
        weekStart.setDate(weekStart.getDate() - 6);
        startStr = weekStart.toISOString().slice(0, 10);
        endStr = weekEnd.toISOString().slice(0, 10);
        break;
      }
    }

    // Get all members
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

    if (!workspace) {
      throw new ApiError("Workspace не найден", "NOT_FOUND", 404);
    }

    // Fetch all activity records for the period
    const activities = await db.memberActivity.findMany({
      where: {
        workspaceId,
        date: { gte: startStr, lte: endStr },
      },
    });

    // Group activities by userId
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
        ) {
          existing.lastSeen = a.lastSeenAt;
        }
      } else {
        activityByUser.set(a.userId, {
          totalMinutes: a.minutesActive,
          daysActive: a.minutesActive > 0 ? 1 : 0,
          lastSeen: a.lastSeenAt,
        });
      }
    }

    // Build response
    const members = workspace.members.map((m) => {
      const activity = activityByUser.get(m.user.id);
      return {
        id: m.user.id,
        login: m.user.login,
        role: m.role,
        lastSeenAt: m.user.lastSeenAt?.toISOString() ?? null,
        totalMinutes: activity?.totalMinutes ?? 0,
        daysActive: activity?.daysActive ?? 0,
      };
    });

    // Include owner if not in members list
    if (!members.find((m) => m.id === workspace.ownerId)) {
      const ownerActivity = activityByUser.get(workspace.ownerId);
      const ownerUser = await db.user.findUnique({
        where: { id: workspace.ownerId },
        select: { lastSeenAt: true },
      });
      members.unshift({
        id: workspace.owner.id,
        login: workspace.owner.login,
        role: "OWNER",
        lastSeenAt: ownerUser?.lastSeenAt?.toISOString() ?? null,
        totalMinutes: ownerActivity?.totalMinutes ?? 0,
        daysActive: ownerActivity?.daysActive ?? 0,
      });
    }

    // Sort by totalMinutes descending
    members.sort((a, b) => b.totalMinutes - a.totalMinutes);

    return NextResponse.json({
      period,
      startDate: startStr,
      endDate: endStr,
      members,
    });
  });
}
