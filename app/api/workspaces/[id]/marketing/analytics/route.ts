import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withErrorHandler, ApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { checkMembership } from "@/lib/services/workspace.service";
import { MktMsgDirection, MktDialogueStage } from "@prisma/client";

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

    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId");

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

    // A/B test analytics: group outgoing messages by variant for a specific project
    let abTestStats: Record<
      string,
      { sent: number; replied: number; interested: number }
    > | null = null;

    if (projectId) {
      // Get all leads for this project
      const projectLeadIds = await db.mktLead.findMany({
        where: { workspaceId, projectId },
        select: { id: true, dialogueStage: true },
      });
      const leadIds = projectLeadIds.map((l) => l.id);

      if (leadIds.length > 0) {
        // Get all dialogues for these leads
        const dialogues = await db.mktDialogue.findMany({
          where: { leadId: { in: leadIds } },
          select: { id: true, leadId: true },
        });
        const dialogueIds = dialogues.map((d) => d.id);

        // Get outgoing messages with variant IDs
        const outMessages = await db.mktMessage.findMany({
          where: {
            dialogueId: { in: dialogueIds },
            direction: MktMsgDirection.OUT,
            abVariantId: { not: null },
          },
          select: {
            abVariantId: true,
            dialogueId: true,
          },
        });

        // Build a map: dialogueId -> leadId
        const dialogueToLead: Record<string, string> = {};
        for (const d of dialogues) {
          dialogueToLead[d.id] = d.leadId;
        }

        // Build lead stage lookup
        const leadStageMap: Record<string, string> = {};
        for (const l of projectLeadIds) {
          leadStageMap[l.id] = l.dialogueStage;
        }

        // Aggregate per variant
        const variantStats: Record<
          string,
          {
            sent: number;
            repliedLeadIds: Set<string>;
            interestedLeadIds: Set<string>;
          }
        > = {};

        for (const msg of outMessages) {
          const vid = msg.abVariantId!;
          if (!variantStats[vid]) {
            variantStats[vid] = {
              sent: 0,
              repliedLeadIds: new Set(),
              interestedLeadIds: new Set(),
            };
          }
          variantStats[vid].sent++;

          const leadId = dialogueToLead[msg.dialogueId];
          if (leadId) {
            const stage = leadStageMap[leadId] as string | undefined;
            if (stage) {
              // Count as replied if lead progressed past AWAITING_REPLY
              const repliedStages: string[] = [
                MktDialogueStage.REPLIED,
                MktDialogueStage.NEGOTIATING,
                MktDialogueStage.DEAL_PENDING,
                MktDialogueStage.WON,
              ];
              if (repliedStages.includes(stage)) {
                variantStats[vid].repliedLeadIds.add(leadId);
              }
              // Count as interested if lead reached negotiation or beyond
              const interestedStages: string[] = [
                MktDialogueStage.NEGOTIATING,
                MktDialogueStage.DEAL_PENDING,
                MktDialogueStage.WON,
              ];
              if (interestedStages.includes(stage)) {
                variantStats[vid].interestedLeadIds.add(leadId);
              }
            }
          }
        }

        // Convert Sets to counts for JSON serialization
        abTestStats = {};
        for (const [vid, stats] of Object.entries(variantStats)) {
          abTestStats[vid] = {
            sent: stats.sent,
            replied: stats.repliedLeadIds.size,
            interested: stats.interestedLeadIds.size,
          };
        }
      }
    }

    return NextResponse.json({
      leadsBySource,
      leadsByStatus,
      totalLeads,
      qualifiedLeads,
      dailyCosts,
      dealStats,
      abTestStats,
    });
  });
}
