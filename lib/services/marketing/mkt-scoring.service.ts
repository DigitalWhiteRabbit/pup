import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from "@/lib/db";

// ─── Types ──────────────────────────────────────────────

export interface VideoAnalysis {
  shortsCount: number;
  shortsRatio: number;
  shortsAvgViews: number;
  longAvgViews: number;
  postingFreq: number;
  totalVideos: number;
}

export interface ScoreBreakdown {
  shorts_fit: number;
  engagement: number;
  activity: number;
  reachability: number;
  size: number;
  details: Record<string, any>;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
  videoAnalysis: VideoAnalysis | null;
}

// ─── Video Analysis ─────────────────────────────────────

export function analyzeVideos(
  lastVideosJson: string | null,
): VideoAnalysis | null {
  if (!lastVideosJson) return null;

  let videos: any[];
  try {
    videos = JSON.parse(lastVideosJson);
  } catch {
    return null;
  }

  if (!Array.isArray(videos) || videos.length === 0) return null;

  const totalVideos = videos.length;

  // A video is a Short if duration <= 180s OR title contains #shorts
  const shorts = videos.filter(
    (v) =>
      (v.duration != null && v.duration <= 180) ||
      (typeof v.title === "string" &&
        v.title.toLowerCase().includes("#shorts")),
  );
  const longs = videos.filter(
    (v) =>
      !(
        (v.duration != null && v.duration <= 180) ||
        (typeof v.title === "string" &&
          v.title.toLowerCase().includes("#shorts"))
      ),
  );

  const shortsCount = shorts.length;
  const shortsRatio = totalVideos > 0 ? shortsCount / totalVideos : 0;

  const shortsAvgViews =
    shortsCount > 0
      ? Math.round(
          shorts.reduce((sum: number, v: any) => sum + (v.views || 0), 0) /
            shortsCount,
        )
      : 0;

  const longAvgViews =
    longs.length > 0
      ? Math.round(
          longs.reduce((sum: number, v: any) => sum + (v.views || 0), 0) /
            longs.length,
        )
      : 0;

  // Posting frequency: videos per week
  // Sort by publishedAt, compute span
  const dated = videos
    .filter((v) => v.publishedAt)
    .sort(
      (a, b) =>
        new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime(),
    );

  let postingFreq = 0;
  if (dated.length >= 2) {
    const first = new Date(dated[0].publishedAt).getTime();
    const last = new Date(dated[dated.length - 1].publishedAt).getTime();
    const weeks = (last - first) / (7 * 24 * 60 * 60 * 1000);
    postingFreq = weeks > 0 ? dated.length / weeks : 0;
  }

  return {
    shortsCount,
    shortsRatio,
    shortsAvgViews,
    longAvgViews,
    postingFreq,
    totalVideos,
  };
}

// ─── Score Computation ──────────────────────────────────

export function computeScore(
  lead: any,
  videoAnalysis: VideoAnalysis | null,
  badFit?: string,
): { score: number; breakdown: ScoreBreakdown } {
  const details: Record<string, any> = {};

  // ── shorts_fit (0-30) ──
  let shortsFit = 0;
  if (videoAnalysis) {
    const ratio = videoAnalysis.shortsRatio;
    if (ratio >= 0.8) shortsFit = 25;
    else if (ratio >= 0.5) shortsFit = 20;
    else if (ratio >= 0.3) shortsFit = 15;
    else if (ratio >= 0.1) shortsFit = 8;
    else shortsFit = 2;

    // Bonus for high shorts views
    if (videoAnalysis.shortsAvgViews >= 100000)
      shortsFit = Math.min(30, shortsFit + 5);
    else if (videoAnalysis.shortsAvgViews >= 50000)
      shortsFit = Math.min(30, shortsFit + 3);
    else if (videoAnalysis.shortsAvgViews >= 10000)
      shortsFit = Math.min(30, shortsFit + 2);

    details.shortsRatio = videoAnalysis.shortsRatio;
    details.shortsAvgViews = videoAnalysis.shortsAvgViews;
  }

  // BAD_FIT_PENALTY: if channel name/about matches badFit keywords, subtract 15
  if (badFit) {
    const keywords = badFit
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);

    const channelText = [
      lead.channelName || "",
      lead.channelAboutText || "",
      lead.mainCategory || "",
    ]
      .join(" ")
      .toLowerCase();

    const matched = keywords.find((kw) => channelText.includes(kw));
    if (matched) {
      shortsFit = Math.max(0, shortsFit - 15);
      details.badFitMatch = matched;
    }
  }

  // ── engagement (0-20) ──
  let engagement = 0;
  const er = lead.erNormalized ?? lead.engagementRate ?? 0;
  if (er >= 0.1) engagement = 20;
  else if (er >= 0.05) engagement = 16;
  else if (er >= 0.02) engagement = 12;
  else if (er >= 0.01) engagement = 8;
  else if (er > 0) engagement = 4;
  details.er = er;

  // ── activity (0-20) ──
  let activity = 0;
  const freq = videoAnalysis?.postingFreq ?? lead.postingFrequency ?? 0;
  if (freq >= 5) activity = 20;
  else if (freq >= 3) activity = 16;
  else if (freq >= 1) activity = 12;
  else if (freq >= 0.5) activity = 6;
  else activity = 2;
  details.postingFreq = freq;

  // ── reachability (0-15) ──
  let reachability = 0;
  if (lead.email) reachability += 10;
  if (lead.telegram) reachability += 5;
  if (lead.instagram || lead.twitter) reachability += 3;
  reachability = Math.min(15, reachability);
  details.hasEmail = !!lead.email;
  details.hasTelegram = !!lead.telegram;

  // ── size (0-15) ──
  let size = 2;
  const subs = lead.subscribers ?? 0;
  if (subs >= 5000 && subs <= 500000) size = 15;
  else if (subs >= 1000 && subs < 5000) size = 12;
  else if (subs > 500000 && subs <= 2000000) size = 10;
  else if (subs >= 500 && subs < 1000) size = 6;
  else if (subs > 2000000) size = 4;
  details.subscribers = subs;

  const score = shortsFit + engagement + activity + reachability + size;

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown: {
      shorts_fit: shortsFit,
      engagement,
      activity,
      reachability,
      size,
      details,
    },
  };
}

// ─── Score Single Lead ──────────────────────────────────

export async function scoreLead(
  workspaceId: string,
  leadId: string,
): Promise<ScoreResult | null> {
  const lead = await db.mktLead.findFirst({
    where: { id: leadId, workspaceId },
  });

  if (!lead) return null;

  // Get active project for badFit keywords
  let badFit: string | undefined;
  if (lead.projectId) {
    const project = await db.mktProject.findUnique({
      where: { id: lead.projectId },
      select: { badFitExamples: true },
    });
    badFit = project?.badFitExamples ?? undefined;
  } else {
    // Fallback: use any active project in workspace
    const activeProject = await db.mktProject.findFirst({
      where: { workspaceId, isActive: true },
      select: { badFitExamples: true },
    });
    badFit = activeProject?.badFitExamples ?? undefined;
  }

  const videoAnalysis = analyzeVideos(lead.lastVideosJson);
  const { score, breakdown } = computeScore(lead, videoAnalysis, badFit);

  // Update lead in DB
  await db.mktLead.update({
    where: { id: leadId },
    data: {
      leadScore: score,
      scoreBreakdown: JSON.stringify(breakdown),
      shortsCount: videoAnalysis?.shortsCount ?? lead.shortsCount,
      shortsRatio: videoAnalysis?.shortsRatio ?? lead.shortsRatio,
      shortsAvgViews: videoAnalysis?.shortsAvgViews ?? lead.shortsAvgViews,
      longAvgViews: videoAnalysis?.longAvgViews ?? lead.longAvgViews,
      postingFrequency: videoAnalysis?.postingFreq ?? lead.postingFrequency,
      scoredAt: new Date(),
    },
  });

  return { score, breakdown, videoAnalysis };
}

// ─── Score All Leads ────────────────────────────────────

export async function scoreAllLeads(workspaceId: string): Promise<number> {
  const leads = await db.mktLead.findMany({
    where: { workspaceId },
    select: { id: true },
  });

  let count = 0;
  for (const lead of leads) {
    const result = await scoreLead(workspaceId, lead.id);
    if (result) count++;
  }

  return count;
}
