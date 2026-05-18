/**
 * Lead Scoring — автоматическая оценка качества канала (0-100).
 *
 * Компоненты скора:
 *   shorts_fit   (0-30) — доля Shorts, avg views Shorts, подходит ли формат
 *   engagement   (0-20) — нормализованный ER
 *   activity     (0-20) — частота постинга
 *   reachability (0-15) — наличие email, telegram, бизнес-контактов
 *   size         (0-15) — подписчики в правильном диапазоне (не слишком мало / много)
 */

const { db } = require("../db/database");

const SHORT_DURATION_SEC = 180; // <= 3 минут = Short/Reel

function analyzeVideos(lastVideosJson) {
  let videos = [];
  try {
    videos = JSON.parse(lastVideosJson || "[]");
  } catch {
    return null;
  }
  if (!videos.length) return null;

  let shortsCount = 0;
  let shortsViews = 0;
  let longCount = 0;
  let longViews = 0;
  let dates = [];

  for (const v of videos) {
    const views = parseInt(v.views || v.viewCount || 0, 10);
    const dur = parseInt(v.duration || 0, 10);
    const title = String(v.title || "").toLowerCase();
    const isShort =
      dur > 0
        ? dur <= SHORT_DURATION_SEC
        : title.includes("#shorts") ||
          title.includes("#short") ||
          title.includes("#reels");

    if (isShort) {
      shortsCount++;
      shortsViews += views;
    } else {
      longCount++;
      longViews += views;
    }
    if (v.publishedAt) {
      try {
        dates.push(new Date(v.publishedAt).getTime());
      } catch {}
    }
  }

  const shortsRatio = videos.length > 0 ? shortsCount / videos.length : 0;
  const shortsAvgViews =
    shortsCount > 0 ? Math.round(shortsViews / shortsCount) : 0;
  const longAvgViews = longCount > 0 ? Math.round(longViews / longCount) : 0;

  // Частота постинга: видео в неделю
  let postingFreq = 0;
  if (dates.length >= 2) {
    dates.sort((a, b) => a - b);
    const spanDays = (dates[dates.length - 1] - dates[0]) / (24 * 3600 * 1000);
    if (spanDays > 0)
      postingFreq = Math.round((dates.length / spanDays) * 7 * 10) / 10;
  }

  return {
    shortsCount,
    shortsRatio,
    shortsAvgViews,
    longAvgViews,
    postingFreq,
    totalVideos: videos.length,
  };
}

function computeScore(lead, videoAnalysis, idealProfile, badFit) {
  const breakdown = {
    shorts_fit: 0,
    engagement: 0,
    activity: 0,
    reachability: 0,
    size: 0,
    details: {},
  };

  // ═══ 1. SHORTS FIT (0-30) ═══
  if (videoAnalysis) {
    const { shortsRatio, shortsAvgViews } = videoAnalysis;
    // Чем больше Shorts — тем лучше для CopyBanner
    if (shortsRatio >= 0.8) breakdown.shorts_fit = 25;
    else if (shortsRatio >= 0.5) breakdown.shorts_fit = 20;
    else if (shortsRatio >= 0.3) breakdown.shorts_fit = 15;
    else if (shortsRatio >= 0.1) breakdown.shorts_fit = 8;
    else breakdown.shorts_fit = 2;

    // Бонус за хорошие просмотры Shorts
    if (shortsAvgViews > 50000)
      breakdown.shorts_fit = Math.min(30, breakdown.shorts_fit + 5);
    else if (shortsAvgViews > 10000)
      breakdown.shorts_fit = Math.min(30, breakdown.shorts_fit + 3);

    breakdown.details.shorts_ratio = shortsRatio;
    breakdown.details.shorts_avg_views = shortsAvgViews;
  }

  // ═══ 2. ENGAGEMENT (0-20) ═══
  const er = parseFloat(lead.er_normalized || lead.engagement_rate || 0);
  if (er >= 0.1) breakdown.engagement = 20;
  else if (er >= 0.05) breakdown.engagement = 16;
  else if (er >= 0.02) breakdown.engagement = 12;
  else if (er >= 0.01) breakdown.engagement = 8;
  else if (er > 0) breakdown.engagement = 4;
  breakdown.details.er = er;

  // ═══ 3. ACTIVITY (0-20) ═══
  if (videoAnalysis) {
    const freq = videoAnalysis.postingFreq;
    if (freq >= 5)
      breakdown.activity = 20; // 5+ видео в неделю
    else if (freq >= 3) breakdown.activity = 16;
    else if (freq >= 1) breakdown.activity = 12;
    else if (freq >= 0.5) breakdown.activity = 6;
    else breakdown.activity = 2;
    breakdown.details.posts_per_week = freq;
  }

  // ═══ 4. REACHABILITY (0-15) ═══
  if (lead.email) breakdown.reachability += 10;
  if (lead.telegram) breakdown.reachability += 5;
  else if (lead.instagram || lead.twitter) breakdown.reachability += 3;
  breakdown.reachability = Math.min(15, breakdown.reachability);

  // ═══ 5. SIZE (0-15) — sweet spot 1K-500K ═══
  const subs = parseInt(lead.subscribers || 0, 10);
  if (subs >= 5000 && subs <= 500000) breakdown.size = 15;
  else if (subs >= 1000 && subs < 5000) breakdown.size = 12;
  else if (subs > 500000 && subs <= 2000000) breakdown.size = 10;
  else if (subs >= 500 && subs < 1000) breakdown.size = 6;
  else if (subs > 2000000) breakdown.size = 4;
  else breakdown.size = 2;
  breakdown.details.subscribers = subs;

  // ═══ BAD FIT PENALTY ═══
  if (badFit && lead.keyword) {
    const kw = String(lead.keyword).toLowerCase();
    const badList = String(badFit)
      .toLowerCase()
      .split(/[,\n;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const bad of badList) {
      if (
        kw.includes(bad) ||
        (lead.channel_name &&
          String(lead.channel_name).toLowerCase().includes(bad))
      ) {
        breakdown.shorts_fit = Math.max(0, breakdown.shorts_fit - 15);
        breakdown.details.bad_fit_match = bad;
        break;
      }
    }
  }

  const total =
    breakdown.shorts_fit +
    breakdown.engagement +
    breakdown.activity +
    breakdown.reachability +
    breakdown.size;
  return { score: Math.min(100, Math.max(0, total)), breakdown };
}

function scoreLead(leadId) {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  if (!lead) return null;

  const project = db
    .prepare("SELECT * FROM projects WHERE is_active = 1 LIMIT 1")
    .get();
  const idealProfile = project?.ideal_channel_profile || "";
  const badFit = project?.bad_fit_examples || "";

  const videoAnalysis = analyzeVideos(lead.last_videos_json);

  const { score, breakdown } = computeScore(
    lead,
    videoAnalysis,
    idealProfile,
    badFit,
  );

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE leads SET
    lead_score = ?, score_breakdown = ?,
    shorts_count = ?, shorts_ratio = ?, shorts_avg_views = ?,
    long_avg_views = ?, posting_frequency = ?, scored_at = ?,
    updated_at = ? WHERE id = ?`,
  ).run(
    score,
    JSON.stringify(breakdown),
    videoAnalysis?.shortsCount ?? null,
    videoAnalysis?.shortsRatio ?? null,
    videoAnalysis?.shortsAvgViews ?? null,
    videoAnalysis?.longAvgViews ?? null,
    videoAnalysis?.postingFreq ?? null,
    now,
    now,
    leadId,
  );

  return { score, breakdown, videoAnalysis };
}

function scoreAllLeads() {
  const leads = db.prepare("SELECT id FROM leads").all();
  let scored = 0;
  for (const { id } of leads) {
    try {
      scoreLead(id);
      scored++;
    } catch (e) {
      console.error(`[scoring] lead #${id}:`, e.message);
    }
  }
  return scored;
}

module.exports = { analyzeVideos, computeScore, scoreLead, scoreAllLeads };
