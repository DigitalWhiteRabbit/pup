import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

// ─── yt-parser proxy config ─────────────────────────────────────────────────
// In production the parser runs on port 3001 (PM2), in dev it may differ.
const YT_PARSER_BASE = process.env.YT_PARSER_URL || "http://localhost:3001";
const FETCH_TIMEOUT = 8_000; // 8s — generous but not infinite

// ─── Types ──────────────────────────────────────────────────────────────────

interface ParserStatus {
  status: string;
  error: string | null;
  logLength: number;
}

interface QuotaResponse {
  used: number;
  total: number;
  remaining: number;
  keys: number;
}

interface LeadCounts {
  total?: number;
  pending?: number;
  ready?: number;
  in_work?: number;
  done?: number;
  rejected?: number;
}

interface Lead {
  id: number;
  lead_status: string;
  dialogue_stage: string;
  [key: string]: unknown;
}

interface Project {
  id: number;
  name: string;
  is_active: number;
  [key: string]: unknown;
}

interface HealthWorker {
  running: boolean;
  lastTick?: string | null;
  daily?: {
    sent_email: number;
    sent_tg: number;
    cap_email: number;
    cap_tg: number;
  };
}

interface HealthQueues {
  leads_pending?: number;
  leads_ready?: number;
  leads_in_work?: number;
  review_pending?: number;
  deals_pending?: number;
  consultations_pending?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch a JSON endpoint from yt-parser with workspace context.
 * Uses the x-workspace-id header (the mechanism yt-parser's middleware reads).
 * Returns null on any failure so one broken sub-request doesn't crash the whole overview.
 */
async function fetchParser<T>(
  path: string,
  workspaceId: string,
): Promise<T | null> {
  try {
    const url = `${YT_PARSER_BASE}${path}`;
    const res = await fetch(url, {
      headers: { "x-workspace-id": workspaceId },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      // Ensure Next.js doesn't cache these responses
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json as T;
  } catch {
    // Parser might be down — that's fine, we return partial data
    return null;
  }
}

// ─── GET handler ────────────────────────────────────────────────────────────

type Params = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    // 1. Auth check
    const session = await auth();
    if (!session)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const workspaceId = params.id;

    // 2. Workspace membership check (ADMIN bypasses)
    if (session.user.role !== "ADMIN") {
      const membership = await db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: session.user.id } },
      });
      if (!membership) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // 3. Fetch data from yt-parser in parallel
    const [statusRes, quotaRes, leadsRes, projectsRes, healthRes] =
      await Promise.all([
        fetchParser<{ success: boolean } & ParserStatus>(
          "/api/status",
          workspaceId,
        ),
        fetchParser<{ success: boolean } & QuotaResponse>(
          "/api/quota",
          workspaceId,
        ),
        fetchParser<{
          success: boolean;
          leads: Lead[];
          counts: LeadCounts;
        }>("/api/leads", workspaceId),
        fetchParser<{ success: boolean; projects: Project[] }>(
          "/api/projects",
          workspaceId,
        ),
        fetchParser<{
          success: boolean;
          worker: HealthWorker;
          queues: HealthQueues;
        }>("/api/health", workspaceId),
      ]);

    // 4. Also fetch CSV channel count (results endpoint)
    const resultsRes = await fetchParser<{
      success: boolean;
      data: unknown[];
    }>("/api/results", workspaceId);

    // 5. Build consolidated response

    // -- Parser status
    const parser = {
      status: statusRes?.status ?? "unknown",
      lastRun: null as string | null,
      channelsInCsv: resultsRes?.data?.length ?? 0,
      apiQuota: {
        used: quotaRes?.used ?? 0,
        total: quotaRes?.total ?? 0,
        remaining: quotaRes?.remaining ?? 0,
        keys: quotaRes?.keys ?? 0,
      },
    };

    // -- Lead counts by status & stage
    const counts = leadsRes?.counts ?? {};
    const leads = leadsRes?.leads ?? [];

    // Count by dialogue_stage from actual leads
    const byStage: Record<string, number> = {};
    for (const lead of leads) {
      const stage = lead.dialogue_stage || "not_contacted";
      byStage[stage] = (byStage[stage] || 0) + 1;
    }

    const leadsOverview = {
      total:
        (counts.pending ?? 0) +
        (counts.ready ?? 0) +
        (counts.in_work ?? 0) +
        (counts.done ?? 0) +
        (counts.rejected ?? 0),
      byStatus: {
        pending: counts.pending ?? 0,
        ready: counts.ready ?? 0,
        in_work: counts.in_work ?? 0,
        done: counts.done ?? 0,
        rejected: counts.rejected ?? 0,
      },
      byStage,
    };

    // -- Campaigns (projects)
    const projects = projectsRes?.projects ?? [];
    const campaigns = projects.map((p) => {
      // Count leads belonging to this project
      const projectLeads = leads.filter(
        (l: Record<string, unknown>) => l.project_id === p.id,
      );
      return {
        id: p.id,
        name: p.name,
        isActive: p.is_active === 1,
        leadsCount: projectLeads.length,
      };
    });

    // -- Worker status from health endpoint
    const workerData = healthRes?.worker;
    const queuesData = healthRes?.queues;
    const worker = {
      running: workerData?.running ?? false,
      lastTick: workerData?.lastTick ?? null,
      dailyEmailsSent: workerData?.daily?.sent_email ?? 0,
      dailyTgSent: workerData?.daily?.sent_tg ?? 0,
      dailyCapEmail: workerData?.daily?.cap_email ?? 200,
      dailyCapTg: workerData?.daily?.cap_tg ?? 50,
    };

    // -- Queues (pending review, deals, etc.)
    const queues = {
      reviewPending: queuesData?.review_pending ?? 0,
      dealsPending: queuesData?.deals_pending ?? 0,
      consultationsPending: queuesData?.consultations_pending ?? 0,
    };

    // 6. Indicate which sub-services were reachable
    const _meta = {
      parserReachable: statusRes !== null,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json({
      parser,
      leads: leadsOverview,
      campaigns,
      worker,
      queues,
      _meta,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
