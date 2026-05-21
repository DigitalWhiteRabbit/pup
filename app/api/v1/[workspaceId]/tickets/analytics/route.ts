import { NextResponse } from "next/server";
import { getTicketAnalytics } from "@/lib/services/tickets/analytics.service";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/tickets/analytics
 * Scope: tickets:analytics
 *
 * Ticket metrics: open/closed counts, avg response time, CSAT,
 * SLA breach stats, category breakdown, source breakdown.
 */
export const GET = withServiceAuth(
  "tickets:analytics",
  async (_req, workspaceId, ctx) => {
    const analytics = await getTicketAnalytics(
      workspaceId,
      ctx.id,
      ctx.role as "ADMIN" | "USER",
    );

    return NextResponse.json(analytics);
  },
);
