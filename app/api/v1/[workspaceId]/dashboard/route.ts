import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/dashboard
 * Scope: dashboard:read
 *
 * Workspace summary: task counts, ticket counts, lead counts,
 * active members, recent activity.
 */
export const GET = withServiceAuth(
  "dashboard:read",
  async (_req, workspaceId) => {
    const [
      taskCounts,
      ticketCounts,
      customerCount,
      leadCounts,
      memberCount,
      recentLogs,
    ] = await Promise.all([
      // Tasks by column
      db.task.groupBy({
        by: ["columnId"],
        where: { workspaceId },
        _count: { id: true },
      }),
      // Tickets by status
      db.ticket.groupBy({
        by: ["status"],
        where: { workspaceId },
        _count: { id: true },
      }),
      // Customers
      db.customer.count({ where: { workspaceId } }),
      // Marketing leads by status
      db.mktLead.groupBy({
        by: ["leadStatus"],
        where: { workspaceId },
        _count: { id: true },
      }),
      // Workspace members
      db.workspaceMember.count({ where: { workspaceId } }),
      // Recent activity (last 20)
      db.activityLog.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          action: true,
          entityType: true,
          summary: true,
          createdAt: true,
          actor: { select: { login: true } },
        },
      }),
    ]);

    // Resolve column names for task counts
    const columnIds = taskCounts.map((tc) => tc.columnId);
    const columns =
      columnIds.length > 0
        ? await db.column.findMany({
            where: { id: { in: columnIds } },
            select: { id: true, name: true, position: true },
            orderBy: { position: "asc" },
          })
        : [];
    const columnMap = new Map(columns.map((c) => [c.id, c.name]));

    const tasksByColumn = taskCounts.map((tc) => ({
      columnId: tc.columnId,
      columnName: columnMap.get(tc.columnId) ?? "Unknown",
      count: tc._count.id,
    }));

    const ticketsByStatus = ticketCounts.map((tc) => ({
      status: tc.status,
      count: tc._count.id,
    }));

    const leadsByStatus = leadCounts.map((lc) => ({
      status: lc.leadStatus,
      count: lc._count.id,
    }));

    return NextResponse.json({
      workspace: workspaceId,
      tasks: {
        total: tasksByColumn.reduce((s, c) => s + c.count, 0),
        byColumn: tasksByColumn,
      },
      tickets: {
        total: ticketsByStatus.reduce((s, c) => s + c.count, 0),
        byStatus: ticketsByStatus,
      },
      customers: {
        total: customerCount,
      },
      leads: {
        total: leadsByStatus.reduce((s, c) => s + c.count, 0),
        byStatus: leadsByStatus,
      },
      members: {
        total: memberCount,
      },
      recentActivity: recentLogs.map((l) => ({
        id: l.id,
        action: l.action,
        entityType: l.entityType,
        summary: l.summary,
        createdAt: l.createdAt,
        actorLogin: l.actor?.login ?? "system",
      })),
    });
  },
);
