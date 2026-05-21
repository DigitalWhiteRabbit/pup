import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/tickets?status=OPEN,IN_PROGRESS&limit=50&offset=0
 * Scope: tickets:read
 *
 * Active tickets with SLA status, messages count, assignee, customer.
 */
export const GET = withServiceAuth("tickets:read", async (req, workspaceId) => {
  const url = new URL(req.url);
  const statusFilter = url.searchParams
    .get("status")
    ?.split(",")
    .filter(Boolean);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");

  const where: Record<string, unknown> = { workspaceId };
  if (statusFilter && statusFilter.length > 0) {
    where.status = { in: statusFilter };
  }

  const [tickets, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      take: limit,
      skip: offset,
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        category: true,
        source: true,
        slaDeadline: true,
        slaBreached: true,
        needsHumanHelp: true,
        agentConfidence: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        closedAt: true,
        assignee: {
          select: { id: true, login: true },
        },
        customer: {
          select: { id: true, email: true, name: true },
        },
        _count: {
          select: { messages: true },
        },
      },
    }),
    db.ticket.count({ where }),
  ]);

  const data = tickets.map((t) => ({
    id: t.id,
    number: t.number,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    category: t.category,
    source: t.source,
    slaDeadline: t.slaDeadline,
    slaBreached: t.slaBreached,
    needsHumanHelp: t.needsHumanHelp,
    agentConfidence: t.agentConfidence,
    assignee: t.assignee,
    customer: t.customer,
    messagesCount: t._count.messages,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
  }));

  return NextResponse.json({ data, total, limit, offset });
});
