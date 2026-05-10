import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import type { ActivityAction, Prisma } from "@prisma/client";
import type { ActivityLogItem } from "@/lib/services/logger.service";
import { z } from "zod";

const filtersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  actions: z.string().optional(),
  search: z.string().optional(),
  workspaceId: z.string().optional(),
});

function safeParse(str: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(str);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
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

    const page = parsed.page;
    const pageSize = parsed.pageSize;
    const skip = (page - 1) * pageSize;

    // Find workspace IDs accessible to this user
    let accessibleWorkspaceIds: string[] | null = null;

    if (session.user.role !== "ADMIN") {
      const memberships = await db.workspaceMember.findMany({
        where: { userId: session.user.id },
        select: { workspaceId: true },
      });
      accessibleWorkspaceIds = memberships.map((m) => m.workspaceId);

      if (accessibleWorkspaceIds.length === 0) {
        return NextResponse.json({ data: [], total: 0 });
      }
    }

    const where: Prisma.ActivityLogWhereInput = {
      // null workspaceId = system events, not shown in global feed unless admin
      workspaceId: { not: null },
      ...(accessibleWorkspaceIds
        ? { workspaceId: { in: accessibleWorkspaceIds } }
        : {}),
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.from || parsed.to
        ? {
            createdAt: {
              ...(parsed.from ? { gte: new Date(parsed.from) } : {}),
              ...(parsed.to ? { lte: new Date(parsed.to) } : {}),
            },
          }
        : {}),
      ...(parsed.actions
        ? { action: { in: parsed.actions.split(",") as ActivityAction[] } }
        : {}),
      ...(parsed.search ? { summary: { contains: parsed.search } } : {}),
    };

    const [logs, total] = await db.$transaction([
      db.activityLog.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          actor: { select: { id: true, login: true } },
          workspace: { select: { id: true, name: true } },
        },
      }),
      db.activityLog.count({ where }),
    ]);

    const data: (ActivityLogItem & { workspaceName: string | null })[] =
      logs.map((log) => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        summary: log.summary,
        metadata: safeParse(log.metadata),
        taskId: log.taskId,
        columnId: log.columnId,
        actor: log.actor ?? null,
        createdAt: log.createdAt,
        workspaceName: log.workspace?.name ?? null,
      }));

    return NextResponse.json({ data, total });
  });
}
