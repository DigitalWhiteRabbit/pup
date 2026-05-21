import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withServiceAuth } from "@/lib/middleware/with-service-auth";

/**
 * GET /api/v1/{workspaceId}/marketing/analytics?projectId=xxx
 * Scope: marketing:analytics
 *
 * Marketing overview: lead stats, daily costs, deal stats.
 * Also fetches yt-parser worker/health status and cost data.
 */

const YT_PARSER_BASE = process.env.YT_PARSER_URL ?? "http://localhost:3001";

export const GET = withServiceAuth(
  "marketing:analytics",
  async (req, workspaceId) => {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId") ?? undefined;

    // Lead filter: optionally scoped to a project
    const leadWhere: { workspaceId: string; projectId?: string } = {
      workspaceId,
    };
    if (projectId) leadWhere.projectId = projectId;

    // PUP DB analytics (MktLead aggregations)
    const [
      leadsBySource,
      leadsByStatus,
      totalLeads,
      qualifiedLeads,
      dailyCosts,
      dealStats,
      activeProjects,
    ] = await Promise.all([
      db.mktLead.groupBy({
        by: ["source"],
        where: leadWhere,
        _count: { id: true },
      }),
      db.mktLead.groupBy({
        by: ["leadStatus"],
        where: leadWhere,
        _count: { id: true },
      }),
      db.mktLead.count({ where: leadWhere }),
      db.mktLead.count({
        where: { ...leadWhere, leadStatus: "READY" },
      }),
      db.mktDailyCounter.findMany({
        where: { workspaceId },
        orderBy: { dateKey: "desc" },
        take: 30,
      }),
      db.mktDeal.groupBy({
        by: ["adminDecision"],
        where: { lead: leadWhere },
        _count: { id: true },
      }),
      db.mktProject.count({
        where: { workspaceId, isActive: true },
      }),
    ]);

    // Fetch yt-parser health + cost (best-effort, non-blocking)
    let parserStatus: Record<string, unknown> | null = null;
    let parserCost: Record<string, unknown> | null = null;
    try {
      const [healthRes, costRes] = await Promise.all([
        fetch(`${YT_PARSER_BASE}/api/health?workspace=${workspaceId}`, {
          headers: { "x-workspace-id": workspaceId },
          signal: AbortSignal.timeout(5_000),
        }),
        fetch(
          `${YT_PARSER_BASE}/api/health/cost?workspace=${workspaceId}&days=30`,
          {
            headers: { "x-workspace-id": workspaceId },
            signal: AbortSignal.timeout(5_000),
          },
        ),
      ]);
      if (healthRes.ok) parserStatus = await healthRes.json();
      if (costRes.ok) parserCost = await costRes.json();
    } catch {
      // yt-parser offline — not critical for analytics response
    }

    return NextResponse.json({
      leadsBySource,
      leadsByStatus,
      totalLeads,
      qualifiedLeads,
      dailyCosts,
      dealStats,
      activeProjects,
      parser: {
        status: parserStatus,
        cost: parserCost,
      },
    });
  },
);
