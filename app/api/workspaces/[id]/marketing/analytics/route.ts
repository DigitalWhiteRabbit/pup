import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.id)
      throw new ApiError("Не авторизован", "UNAUTHORIZED", 401);
    const { id: workspaceId } = await params;

    const membership = await checkMembership(workspaceId, session.user.id);
    if (!membership && session.user.role !== "ADMIN")
      throw new ApiError("Forbidden", "FORBIDDEN", 403);

    const [
      leadsBySource,
      leadsByStatus,
      totalLeads,
      qualifiedLeads,
      dailyCosts,
      dealStats,
    ] = await Promise.all([
      db.mktLead.groupBy({
        by: ["source"],
        where: { workspaceId },
        _count: { id: true },
      }),
      db.mktLead.groupBy({
        by: ["leadStatus"],
        where: { workspaceId },
        _count: { id: true },
      }),
      db.mktLead.count({ where: { workspaceId } }),
      db.mktLead.count({ where: { workspaceId, leadStatus: "READY" } }),
      db.mktDailyCounter.findMany({
        where: { workspaceId },
        orderBy: { dateKey: "desc" },
        take: 30,
      }),
      db.mktDeal.groupBy({
        by: ["adminDecision"],
        where: { lead: { workspaceId } },
        _count: { id: true },
      }),
    ]);

    return NextResponse.json({
      leadsBySource,
      leadsByStatus,
      totalLeads,
      qualifiedLeads,
      dailyCosts,
      dealStats,
    });
  });
}
