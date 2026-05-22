import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { z } from "zod";

type Params = { params: { id: string } };

const querySchema = z.object({
  date: z.string().optional(), // "2026-05-22"
  userId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/workspaces/[id]/click-logs
 *
 * Returns click/action events for all (or one specific) member in a workspace.
 * Only accessible by workspace owner or ADMIN.
 */
export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Unauthorized", "UNAUTHORIZED", 401);

    const workspaceId = params.id;

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
          "Только владелец или админ может просматривать логи",
          "FORBIDDEN",
          403,
        );
      }
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

    const where: Record<string, unknown> = {
      workspaceId,
      ...(parsed.userId ? { userId: parsed.userId } : {}),
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
          userId: true,
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
