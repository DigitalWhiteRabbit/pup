import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { z } from "zod";

type Params = { params: { id: string; userId: string } };

const querySchema = z.object({
  date: z.string().optional(), // "2026-05-22"
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/workspaces/[id]/members/[userId]/click-logs
 *
 * Returns timeline of click/action events for a member in a workspace.
 * Only accessible by workspace owner or ADMIN.
 */
export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Unauthorized", "UNAUTHORIZED", 401);

    const workspaceId = params.id;
    const targetUserId = params.userId;

    // Check access: must be ADMIN or workspace OWNER
    const isAdmin = session.user.role === "ADMIN";
    if (!isAdmin) {
      const membership = await db.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId, userId: session.user.id },
        },
        select: { role: true },
      });
      if (!membership || membership.role !== "OWNER") {
        throw new ApiError(
          "Только владелец или админ может просматривать логи участников",
          "FORBIDDEN",
          403,
        );
      }
    }

    // Verify target user is a member of the workspace
    const targetMembership = await db.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId: targetUserId },
      },
      select: { userId: true },
    });
    if (!targetMembership) {
      throw new ApiError(
        "Пользователь не является участником workspace",
        "NOT_FOUND",
        404,
      );
    }

    const { searchParams } = new URL(req.url);
    const parsed = querySchema.parse(Object.fromEntries(searchParams));

    // Build date range filter
    let dateStart: Date | undefined;
    let dateEnd: Date | undefined;
    if (parsed.date) {
      dateStart = new Date(parsed.date + "T00:00:00.000Z");
      dateEnd = new Date(parsed.date + "T23:59:59.999Z");
    }

    const where = {
      userId: targetUserId,
      workspaceId,
      ...(dateStart && dateEnd
        ? { occurredAt: { gte: dateStart, lte: dateEnd } }
        : {}),
    };

    const [logs, total] = await db.$transaction([
      db.memberClickLog.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        take: parsed.limit,
        skip: parsed.offset,
        select: {
          id: true,
          action: true,
          target: true,
          details: true,
          occurredAt: true,
        },
      }),
      db.memberClickLog.count({ where }),
    ]);

    return NextResponse.json({ data: logs, total });
  });
}
