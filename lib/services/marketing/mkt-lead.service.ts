import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from "@/lib/db";
import type {
  MktLeadStatus,
  MktDialogueStage,
  MktLeadSource,
} from "@prisma/client";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface LeadFilters {
  status?: MktLeadStatus;
  stage?: MktDialogueStage;
  source?: MktLeadSource;
  search?: string;
  scoreLevel?: "high" | "medium" | "low";
  hasEmail?: boolean;
  limit?: number;
  offset?: number;
}

interface LeadListResult {
  leads: any[];
  total: number;
  counts: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// List / Search
// ═══════════════════════════════════════════════════════════════════════════

export async function listLeads(
  workspaceId: string,
  filters: LeadFilters = {},
): Promise<LeadListResult> {
  const where: any = { workspaceId };

  if (filters.status) where.leadStatus = filters.status;
  if (filters.stage) where.dialogueStage = filters.stage;
  if (filters.source) where.source = filters.source;

  if (filters.hasEmail === true) {
    where.email = { not: null };
  } else if (filters.hasEmail === false) {
    where.email = null;
  }

  if (filters.search) {
    where.OR = [
      { channelName: { contains: filters.search, mode: "insensitive" } },
      { email: { contains: filters.search, mode: "insensitive" } },
      { channelUrl: { contains: filters.search, mode: "insensitive" } },
      { telegram: { contains: filters.search, mode: "insensitive" } },
      { notes: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  if (filters.scoreLevel) {
    // Load thresholds from config
    const config = await db.mktConfig.findUnique({
      where: { workspaceId },
      select: { scoreThresholdHigh: true, scoreThresholdMedium: true },
    });
    const high = config?.scoreThresholdHigh ?? 0.75;
    const medium = config?.scoreThresholdMedium ?? 0.4;

    if (filters.scoreLevel === "high") {
      where.leadScore = { gte: high };
    } else if (filters.scoreLevel === "medium") {
      where.leadScore = { gte: medium, lt: high };
    } else {
      where.leadScore = { lt: medium };
    }
  }

  const [leads, total] = await Promise.all([
    db.mktLead.findMany({
      where,
      orderBy: [{ leadScore: "desc" }, { createdAt: "desc" }],
      take: filters.limit || 50,
      skip: filters.offset || 0,
      include: {
        project: { select: { id: true, name: true } },
      },
    }),
    db.mktLead.count({ where }),
  ]);

  // Get counts in parallel
  const counts = await getLeadCounts(workspaceId);

  return { leads, total, counts };
}

// ═══════════════════════════════════════════════════════════════════════════
// Get Single Lead
// ═══════════════════════════════════════════════════════════════════════════

export async function getLead(workspaceId: string, leadId: string) {
  const lead = await db.mktLead.findFirst({
    where: { id: leadId, workspaceId },
    include: {
      project: { select: { id: true, name: true } },
      dialogues: {
        include: {
          messages: { orderBy: { createdAt: "asc" }, take: 50 },
        },
        orderBy: { createdAt: "desc" },
      },
      deals: { orderBy: { createdAt: "desc" } },
      emails: true,
    },
  });

  if (!lead) throw new Error("Lead not found");
  return lead;
}

// ═══════════════════════════════════════════════════════════════════════════
// Lead Status State Machine
// ═══════════════════════════════════════════════════════════════════════════

const VALID_LEAD_TRANSITIONS: Record<MktLeadStatus, MktLeadStatus[]> = {
  PENDING: ["READY", "IN_WORK", "REJECTED"],
  READY: ["IN_WORK", "REJECTED", "PENDING"],
  IN_WORK: ["DONE", "REJECTED", "PENDING"],
  DONE: ["IN_WORK", "PENDING"],
  REJECTED: ["PENDING"],
};

// ═══════════════════════════════════════════════════════════════════════════
// Update Lead
// ═══════════════════════════════════════════════════════════════════════════

export async function updateLead(
  workspaceId: string,
  leadId: string,
  data: {
    leadStatus?: MktLeadStatus;
    notes?: string;
    projectId?: string | null;
  },
) {
  // Verify ownership
  const existing = await db.mktLead.findFirst({
    where: { id: leadId, workspaceId },
  });
  if (!existing) throw new Error("Lead not found");

  // Validate status transition
  if (
    data.leadStatus !== undefined &&
    data.leadStatus !== existing.leadStatus
  ) {
    const allowed = VALID_LEAD_TRANSITIONS[existing.leadStatus];
    if (!allowed.includes(data.leadStatus)) {
      throw new Error(
        `Invalid status transition: ${existing.leadStatus} → ${data.leadStatus}`,
      );
    }
  }

  return db.mktLead.update({
    where: { id: leadId },
    data: {
      ...(data.leadStatus !== undefined && { leadStatus: data.leadStatus }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.projectId !== undefined && { projectId: data.projectId }),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Bulk Update Status
// ═══════════════════════════════════════════════════════════════════════════

export async function bulkUpdateStatus(
  workspaceId: string,
  leadIds: string[],
  status: MktLeadStatus,
): Promise<number> {
  const result = await db.mktLead.updateMany({
    where: {
      id: { in: leadIds },
      workspaceId,
    },
    data: { leadStatus: status },
  });
  return result.count;
}

// ═══════════════════════════════════════════════════════════════════════════
// Delete Lead
// ═══════════════════════════════════════════════════════════════════════════

export async function deleteLead(
  workspaceId: string,
  leadId: string,
): Promise<void> {
  const existing = await db.mktLead.findFirst({
    where: { id: leadId, workspaceId },
  });
  if (!existing) throw new Error("Lead not found");

  await db.mktLead.delete({ where: { id: leadId } });
}

// ═══════════════════════════════════════════════════════════════════════════
// Create Manual Lead
// ═══════════════════════════════════════════════════════════════════════════

export async function createManualLead(
  workspaceId: string,
  data: {
    channelName: string;
    channelUrl?: string;
    source: MktLeadSource;
    email?: string;
    telegram?: string;
    notes?: string;
  },
) {
  // Generate channelId from URL or name
  let channelId: string;
  if (data.channelUrl) {
    // Try to extract channel ID from YouTube URL
    const ytMatch = data.channelUrl.match(
      /(?:youtube\.com\/(?:channel\/|@))([a-zA-Z0-9_\-]+)/,
    );
    channelId = ytMatch?.[1] ?? data.channelUrl;
  } else {
    // Generate from name + source + timestamp
    channelId = `manual_${data.source.toLowerCase()}_${data.channelName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .slice(0, 30)}_${Date.now()}`;
  }

  const lead = await db.$transaction(async (tx) => {
    const created = await tx.mktLead.create({
      data: {
        workspaceId,
        channelId,
        channelName: data.channelName,
        channelUrl: data.channelUrl || null,
        source: data.source,
        email: data.email || null,
        telegram: data.telegram || null,
        notes: data.notes || null,
        leadStatus: "PENDING",
        dialogueStage: "NOT_CONTACTED",
      },
    });

    // Create email lookup if email provided
    if (data.email) {
      await tx.mktLeadEmail.create({
        data: { leadId: created.id, email: data.email },
      });
    }

    return created;
  });

  return lead;
}

// ═══════════════════════════════════════════════════════════════════════════
// Lead Counts
// ═══════════════════════════════════════════════════════════════════════════

export async function getLeadCounts(
  workspaceId: string,
): Promise<Record<string, number>> {
  const [byStatus, bySource, total] = await Promise.all([
    db.mktLead.groupBy({
      by: ["leadStatus"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    db.mktLead.groupBy({
      by: ["source"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    db.mktLead.count({ where: { workspaceId } }),
  ]);

  const counts: Record<string, number> = { total };

  for (const row of byStatus) {
    counts[`status_${row.leadStatus}`] = row._count._all;
  }
  for (const row of bySource) {
    counts[`source_${row.source}`] = row._count._all;
  }

  // Count leads with email
  const withEmail = await db.mktLead.count({
    where: { workspaceId, email: { not: null } },
  });
  counts.withEmail = withEmail;

  return counts;
}
