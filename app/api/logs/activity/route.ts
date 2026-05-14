import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import type { ActivityAction, Prisma } from "@prisma/client";
import { z } from "zod";

const filtersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  from: z.string().optional(),
  to: z.string().optional(),
  actions: z.string().optional(),
  search: z.string().optional(),
  workspaceId: z.string().optional(),
  actorId: z.string().optional(),
  systemOnly: z.coerce.boolean().optional(),
  stats: z.coerce.boolean().optional(),
});

function safeParse(str: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(str);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session) throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);

    const { searchParams } = new URL(req.url);
    const parsed = filtersSchema.parse(Object.fromEntries(searchParams));

    const isAdmin = session.user.role === "ADMIN";

    // Access control
    let accessibleWorkspaceIds: string[] | null = null;
    if (!isAdmin) {
      const memberships = await db.workspaceMember.findMany({
        where: { userId: session.user.id },
        select: { workspaceId: true },
      });
      accessibleWorkspaceIds = memberships.map((m) => m.workspaceId);
      if (accessibleWorkspaceIds.length === 0)
        return NextResponse.json({
          data: [],
          total: 0,
          stats: null,
          actors: [],
        });
    }

    // Build where clause
    const where: Prisma.ActivityLogWhereInput = {};

    if (parsed.systemOnly && isAdmin) {
      where.workspaceId = null;
    } else if (accessibleWorkspaceIds) {
      where.workspaceId = { in: accessibleWorkspaceIds };
    }

    if (parsed.workspaceId) where.workspaceId = parsed.workspaceId;
    if (parsed.actorId) where.actorId = parsed.actorId;

    if (parsed.from || parsed.to) {
      where.createdAt = {
        ...(parsed.from ? { gte: new Date(parsed.from) } : {}),
        ...(parsed.to ? { lte: new Date(parsed.to) } : {}),
      };
    }

    if (parsed.actions)
      where.action = { in: parsed.actions.split(",") as ActivityAction[] };
    if (parsed.search) where.summary = { contains: parsed.search };

    const page = parsed.page;
    const pageSize = parsed.pageSize;
    const skip = (page - 1) * pageSize;

    const [logs, total] = await db.$transaction([
      db.activityLog.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          actor: { select: { id: true, login: true, avatarPath: true } },
          workspace: { select: { id: true, name: true } },
        },
      }),
      db.activityLog.count({ where }),
    ]);

    const data = logs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      summary: log.summary,
      metadata: safeParse(log.metadata),
      taskId: log.taskId,
      columnId: log.columnId,
      workspaceId: log.workspaceId,
      actor: log.actor
        ? {
            id: log.actor.id,
            login: log.actor.login,
            hasAvatar: !!log.actor.avatarPath,
          }
        : null,
      createdAt: log.createdAt,
      workspaceName: log.workspace?.name ?? null,
    }));

    // Stats (only if requested)
    let stats = null;
    let actors: { id: string; login: string; hasAvatar: boolean }[] = [];

    if (parsed.stats) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const baseWhere: Prisma.ActivityLogWhereInput = accessibleWorkspaceIds
        ? { workspaceId: { in: accessibleWorkspaceIds } }
        : {};

      const [todayCount, weekCount, topActors] = await db.$transaction([
        db.activityLog.count({
          where: { ...baseWhere, createdAt: { gte: todayStart } },
        }),
        db.activityLog.count({
          where: {
            ...baseWhere,
            createdAt: { gte: new Date(Date.now() - 7 * 86400000) },
          },
        }),
        db.activityLog.groupBy({
          by: ["actorId"],
          where: {
            ...baseWhere,
            actorId: { not: null },
            createdAt: { gte: new Date(Date.now() - 7 * 86400000) },
          },
          _count: true,
          orderBy: { _count: { actorId: "desc" } },
          take: 1,
        }),
      ]);

      let topActor: { login: string; count: number } | null = null;
      if (topActors[0]?.actorId) {
        const u = await db.user.findUnique({
          where: { id: topActors[0].actorId },
          select: { login: true },
        });
        if (u)
          topActor = {
            login: u.login,
            count: topActors[0]._count as unknown as number,
          };
      }

      stats = { todayCount, weekCount, topActor };

      // Get unique actors for filter dropdown
      const actorRows = await db.activityLog.findMany({
        where: baseWhere,
        distinct: ["actorId"],
        select: {
          actor: { select: { id: true, login: true, avatarPath: true } },
        },
        take: 50,
      });
      actors = actorRows
        .filter((r) => r.actor)
        .map((r) => ({
          id: r.actor!.id,
          login: r.actor!.login,
          hasAvatar: !!r.actor!.avatarPath,
        }));
    }

    return NextResponse.json({ data, total, stats, actors });
  });
}
