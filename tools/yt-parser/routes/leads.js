const express = require("express");
const path = require("path");
const { getDb, syncLeadEmails } = require("../db/database");
const { importFromCsv } = require("../db/lead-importer");
const { adminAuth } = require("../utils/auth");
const scoring = require("../services/lead-scoring");

const router = express.Router();

// Защита всех мутаций на этом роутере (GET пропускаются).
router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

// Workspace isolation: resolve db + stmts per request
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

// Безопасный парсинг project_id: вернуть число > 0 или null
function parseProjectId(raw) {
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const VALID_LEAD_STATUSES = ["pending", "ready", "in_work", "done", "rejected"];
const VALID_DIALOGUE_STAGES = [
  "not_contacted",
  "queued",
  "awaiting_review",
  "contacted",
  "awaiting_reply",
  "followup_1",
  "followup_2",
  "replied",
  "negotiating",
  "deal_pending",
  "won",
  "lost",
];

// GET /api/leads?status=pending&stage=not_contacted&limit=50&offset=0
router.get("/", (req, res) => {
  const status = req.query.status || null;
  const stage = req.query.stage || null;
  const limit = parseInt(req.query.limit, 10) || 100;
  const offset = parseInt(req.query.offset, 10) || 0;

  if (status && !VALID_LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, error: "invalid status" });
  }
  if (stage && !VALID_DIALOGUE_STAGES.includes(stage)) {
    return res.status(400).json({ success: false, error: "invalid stage" });
  }

  const leads = req.stmts.listLeads.all({ status, stage, limit, offset });
  const counts = req.stmts.countLeads.get();

  res.json({ success: true, leads, counts });
});

// GET /api/leads/:id
router.get("/:id", (req, res) => {
  const lead = req.stmts.getLead.get(req.params.id);
  if (!lead)
    return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, lead });
});

// PATCH /api/leads/:id  { lead_status?, notes? }
router.patch("/:id", (req, res) => {
  const { lead_status, notes } = req.body;
  const id = parseInt(req.params.id, 10);
  const now = new Date().toISOString();

  if (lead_status !== undefined) {
    if (!VALID_LEAD_STATUSES.includes(lead_status)) {
      return res
        .status(400)
        .json({ success: false, error: "invalid lead_status" });
    }
    req.stmts.updateLeadStatus.run(lead_status, now, id);
  }
  if (notes !== undefined) {
    req.stmts.updateLeadNotes.run(notes, now, id);
  }

  const lead = req.stmts.getLead.get(id);
  res.json({ success: true, lead });
});

// POST /api/leads/bulk-status  { ids: [], lead_status: '' }
router.post("/bulk-status", (req, res) => {
  const { ids, lead_status } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: "ids required" });
  }
  if (!VALID_LEAD_STATUSES.includes(lead_status)) {
    return res
      .status(400)
      .json({ success: false, error: "invalid lead_status" });
  }

  const now = new Date().toISOString();
  const tx = req.db.transaction((idArr) => {
    for (const id of idArr)
      req.stmts.updateLeadStatus.run(lead_status, now, id);
  });
  tx(ids);

  res.json({ success: true, updated: ids.length });
});

// POST /api/leads/promote — промоут канала из Dashboard в Лиды (создать если нет + статус ready)
router.post("/promote", (req, res) => {
  const row = req.body;
  if (!row || !row.channel_id)
    return res
      .status(400)
      .json({ success: false, error: "channel_id required" });

  const now = new Date().toISOString();
  try {
    // Проверяем существует ли лид
    const existing = req.db
      .prepare("SELECT id FROM leads WHERE channel_id = ?")
      .get(row.channel_id);
    if (existing) {
      // Обновляем статус
      req.stmts.updateLeadStatus.run("ready", now, existing.id);
      const lead = req.stmts.getLead.get(existing.id);
      return res.json({ success: true, lead, created: false });
    }

    // Создаём нового лида. Если парсер прислал contacts_detailed — сохраняем полный объект,
    // иначе — старый плоский формат.
    const rawContacts = JSON.stringify(
      row.contacts_detailed
        ? { ...row.contacts_detailed, _detailed: true }
        : {
            email: row.email || "",
            telegram: row.telegram || "",
            instagram: row.instagram || "",
            twitter: row.twitter || "",
            tiktok: row.tiktok || "",
            vk: row.vk || "",
            discord: row.discord || "",
            whatsapp: row.whatsapp || "",
            website: row.website || "",
          },
    );

    // Определяем project_id: из тела запроса → активный проект
    const projectId =
      parseProjectId(row.project_id) ??
      (req.stmts.getActiveProject.get() || {}).id ??
      null;

    const result = req.stmts.insertLead.run({
      channel_id: row.channel_id,
      channel_name: row.channel_name || "",
      channel_url: row.channel_url || "",
      thumbnail: row.thumbnail || "",
      country: row.country || "",
      subscribers: parseInt(row.subscribers, 10) || 0,
      avg_views: parseInt(row.avg_views_per_video, 10) || 0,
      engagement_rate: parseFloat(row.engagement_rate) || 0,
      email: row.email || "",
      telegram: row.telegram || "",
      whatsapp: row.whatsapp || "",
      raw_contacts: rawContacts,
      keyword: row.keyword || "",
      created_at: now,
      updated_at: now,
    });
    // Привязываем к проекту
    if (projectId)
      req.stmts.updateLeadProject.run(projectId, now, result.lastInsertRowid);
    // Сразу ставим ready
    req.stmts.updateLeadStatus.run("ready", now, result.lastInsertRowid);
    // Сохраняем snapshot контента (видео + about + новые поля enrichment) для качественной сводки
    try {
      const erFlagsStr = Array.isArray(row.er_flags)
        ? row.er_flags.join(",")
        : row.er_flags || null;
      req.stmts.updateLeadEnrichment.run({
        id: result.lastInsertRowid,
        last_videos_json: row.last_videos_json || null,
        channel_about_text: row.channel_about_text || null,
        channel_tags: row.channel_tags || null,
        top_playlists_json: row.top_playlists_json || null,
        channel_age_days:
          row.channel_age_days != null ? Number(row.channel_age_days) : null,
        channel_language: row.channel_language || null,
        main_category: row.main_category || null,
        er_normalized:
          row.engagement_rate_normalized != null
            ? Number(row.engagement_rate_normalized)
            : null,
        er_flags: erFlagsStr,
        enriched_at: now,
      });
    } catch (e) {
      console.error("[promote] save content snapshot:", e.message);
    }
    try {
      syncLeadEmails(req.workspaceId, result.lastInsertRowid, row.email || "");
    } catch (e) {
      console.error("[promote] syncLeadEmails:", e.message);
    }
    try {
      scoring.scoreLead(result.lastInsertRowid);
    } catch (e) {
      console.error("[promote] scoring:", e.message);
    }
    const lead = req.stmts.getLead.get(result.lastInsertRowid);
    res.json({ success: true, lead, created: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leads/create-manual — создать тестового лида вручную
router.post("/create-manual", (req, res) => {
  const {
    channel_name,
    email,
    telegram,
    channel_url,
    country,
    subscribers,
    project_id,
  } = req.body;
  if (!channel_name)
    return res
      .status(400)
      .json({ success: false, error: "channel_name required" });
  if (!email && !telegram)
    return res
      .status(400)
      .json({ success: false, error: "Нужен хотя бы email или telegram" });

  const now = new Date().toISOString();
  const channelId = "MANUAL_" + Date.now();

  try {
    const result = req.stmts.insertLead.run({
      channel_id: channelId,
      channel_name,
      channel_url: channel_url || "",
      thumbnail: "",
      country: country || "",
      subscribers: parseInt(subscribers, 10) || 0,
      avg_views: 0,
      engagement_rate: 0,
      email: email || "",
      telegram: (telegram || "").replace(/^@/, ""),
      whatsapp: "",
      raw_contacts: JSON.stringify({
        email: email || "",
        telegram: telegram || "",
      }),
      keyword: "manual",
      created_at: now,
      updated_at: now,
    });
    // Привязываем к проекту
    const projectId =
      parseProjectId(project_id) ??
      (req.stmts.getActiveProject.get() || {}).id ??
      null;
    if (projectId)
      req.stmts.updateLeadProject.run(projectId, now, result.lastInsertRowid);
    try {
      syncLeadEmails(req.workspaceId, result.lastInsertRowid, email || "");
    } catch (e) {
      console.error("[create-manual] syncLeadEmails:", e.message);
    }
    const lead = req.stmts.getLead.get(result.lastInsertRowid);
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/leads/all  — удалить ВСЕХ лидов и связанные диалоги/сделки
router.delete("/all", (req, res) => {
  try {
    const tx = req.db.transaction(() => {
      req.db.prepare("DELETE FROM messages").run();
      req.db.prepare("DELETE FROM dialogues").run();
      req.db.prepare("DELETE FROM deals").run();
      req.db.prepare("DELETE FROM consultations").run();
      req.db.prepare("DELETE FROM leads").run();
    });
    tx();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leads/:id/run — немедленный запуск AI-агента для готового лида
router.post("/:id/run", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "invalid id" });

  const lead = req.stmts.getLead.get(id);
  if (!lead)
    return res.status(404).json({ success: false, error: "not found" });
  if (lead.lead_status !== "ready") {
    return res
      .status(400)
      .json({ success: false, error: 'lead_status must be "ready"' });
  }

  const now = new Date().toISOString();
  try {
    req.db
      .prepare(
        `UPDATE leads SET locked_until = NULL, dialogue_stage = 'not_contacted', updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
    // Немедленно обрабатываем ИМЕННО этого лида (не ждём очередь воркера)
    setImmediate(() => {
      try {
        const worker = require("../services/outreach-worker");
        if (!worker) return;
        if (typeof worker.runLeadNow === "function") {
          worker
            .runLeadNow(id, req.workspaceId)
            .catch((err) =>
              console.error("[leads/run] runLeadNow error:", err.message),
            );
        }
      } catch (err) {
        console.error("[leads/run] failed to trigger worker:", err.message);
      }
    });
    res.json({ success: true, queued: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/leads/:id — удалить лид со всеми связанными записями
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "invalid id" });

  const lead = req.stmts.getLead.get(id);
  if (!lead)
    return res.status(404).json({ success: false, error: "not found" });

  try {
    const tx = req.db.transaction((leadId) => {
      req.db
        .prepare(
          "DELETE FROM messages WHERE dialogue_id IN (SELECT id FROM dialogues WHERE lead_id = ?)",
        )
        .run(leadId);
      req.db.prepare("DELETE FROM deals WHERE lead_id = ?").run(leadId);
      req.db.prepare("DELETE FROM consultations WHERE lead_id = ?").run(leadId);
      req.db.prepare("DELETE FROM dialogues WHERE lead_id = ?").run(leadId);
      req.db.prepare("DELETE FROM leads WHERE id = ?").run(leadId);
    });
    tx(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leads/:id/summary — сгенерировать AI-сводку контента для одного лида
router.post("/:id/summary", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "invalid id" });

  const lead = req.stmts.getLead.get(id);
  if (!lead)
    return res.status(404).json({ success: false, error: "not found" });

  try {
    const ai = require("../services/ai");
    const project =
      (lead.project_id ? req.stmts.getProject.get(lead.project_id) : null) ||
      req.stmts.getActiveProject.get() ||
      null;
    const summary = await ai.generateContentSummary(lead, project);
    const now = new Date().toISOString();
    req.stmts.updateLeadSummary.run(summary, now, id);
    const updated = req.stmts.getLead.get(id);
    res.json({ success: true, lead: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leads/bulk-summary — фоновая генерация сводок (возвращает 202 + job_id)
// In-memory state одной задачи (концурентность не нужна — задача тяжёлая, одна за раз)
let bulkSummaryJob = null; // { id, running, processed, failed, total, startedAt, finishedAt, error }

router.post("/bulk-summary", (req, res) => {
  if (bulkSummaryJob && bulkSummaryJob.running) {
    return res.status(409).json({
      success: false,
      error: "Bulk-summary уже выполняется",
      job_id: bulkSummaryJob.id,
    });
  }
  try {
    const ai = require("../services/ai");
    const targets = req.stmts.listLeadsWithoutSummary.all(100);
    const job = {
      id: Date.now(),
      running: true,
      processed: 0,
      failed: 0,
      total: targets.length,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      done: false,
    };
    bulkSummaryJob = job;
    const bulkProject = req.stmts.getActiveProject.get() || null;

    setImmediate(async () => {
      for (const lead of targets) {
        try {
          const leadProject =
            (lead.project_id
              ? req.stmts.getProject.get(lead.project_id)
              : null) || bulkProject;
          const summary = await ai.generateContentSummary(lead, leadProject);
          const now = new Date().toISOString();
          req.stmts.updateLeadSummary.run(summary, now, lead.id);
          job.processed++;
        } catch (err) {
          console.error("[bulk-summary] lead", lead.id, "failed:", err.message);
          job.failed++;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      job.running = false;
      job.done = true;
      job.finishedAt = new Date().toISOString();
    });

    res.status(202).json({
      success: true,
      job_id: job.id,
      total: job.total,
      message: "Генерация запущена в фоне",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/leads/bulk-summary/status — статус фоновой задачи
router.get("/bulk-summary/status", (req, res) => {
  if (!bulkSummaryJob) {
    return res.json({ success: true, job: null });
  }
  const j = bulkSummaryJob;
  res.json({
    success: true,
    job: {
      id: j.id,
      running: j.running,
      done: j.done,
      processed: j.processed,
      failed: j.failed,
      total: j.total,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      error: j.error,
    },
  });
});

// ─── Enrich: back-fill из cache.json ─────────────────────────────────────
const fs = require("fs");
const CACHE_FILE = path.join(__dirname, "..", "cache.json");

function readCacheSafe() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } catch (e) {
    console.error("[enrich] cache read failed:", e.message);
    return null;
  }
}

function buildEnrichmentFromCache(cached) {
  if (!cached) return null;
  // cache.json в этом проекте хранит processed-объект напрямую (с полем cached_at),
  // а не обёртку {cachedAt, data}. Поддержим оба варианта.
  const data = cached.data || cached;
  if (!data || !data.channel_id) return null;
  const erFlagsArr = Array.isArray(data.er_flags) ? data.er_flags : null;
  return {
    last_videos_json: data.last_videos_json || null,
    channel_about_text: data.channel_about_text || null,
    channel_tags: data.channel_tags || null,
    top_playlists_json: data.top_playlists_json || null,
    channel_age_days:
      data.channel_age_days != null ? Number(data.channel_age_days) : null,
    channel_language: data.channel_language || null,
    main_category: data.main_category || null,
    er_normalized:
      data.engagement_rate_normalized != null
        ? Number(data.engagement_rate_normalized)
        : null,
    er_flags: erFlagsArr ? erFlagsArr.join(",") : null,
  };
}

// POST /api/leads/:id/enrich — back-fill полей из cache.json
router.post("/:id/enrich", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "invalid id" });
  const lead = req.stmts.getLead.get(id);
  if (!lead)
    return res.status(404).json({ success: false, error: "not found" });
  if (!lead.channel_id)
    return res
      .status(400)
      .json({ success: false, error: "lead has no channel_id" });

  const cache = readCacheSafe();
  if (!cache || !cache.channels) {
    return res
      .status(404)
      .json({ success: false, error: "cache.json not available" });
  }
  const cached = cache.channels[lead.channel_id];
  if (!cached) {
    return res
      .status(404)
      .json({ success: false, error: "no cached data for this channel_id" });
  }
  const enrich = buildEnrichmentFromCache(cached);
  if (!enrich) {
    return res
      .status(500)
      .json({ success: false, error: "failed to build enrichment payload" });
  }
  try {
    const now = new Date().toISOString();
    req.stmts.updateLeadEnrichment.run({ id, enriched_at: now, ...enrich });
    res.json({ success: true, lead: req.stmts.getLead.get(id) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leads/bulk-enrich — фоновое обогащение всех необогащённых лидов
let bulkEnrichJob = null;
router.post("/bulk-enrich", (req, res) => {
  if (bulkEnrichJob && bulkEnrichJob.running) {
    return res.status(409).json({
      success: false,
      error: "bulk-enrich уже выполняется",
      job_id: bulkEnrichJob.id,
    });
  }
  const cache = readCacheSafe();
  if (!cache || !cache.channels) {
    return res
      .status(404)
      .json({ success: false, error: "cache.json not available" });
  }
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const targets = req.stmts.listLeadsForEnrichment.all(cutoff, 1000);
  const job = {
    id: Date.now(),
    running: true,
    processed: 0,
    skipped: 0,
    failed: 0,
    total: targets.length,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    done: false,
  };
  bulkEnrichJob = job;
  setImmediate(() => {
    for (const t of targets) {
      try {
        const cached = cache.channels[t.channel_id];
        if (!cached) {
          job.skipped++;
          continue;
        }
        const enrich = buildEnrichmentFromCache(cached);
        if (!enrich) {
          job.skipped++;
          continue;
        }
        const now = new Date().toISOString();
        req.stmts.updateLeadEnrichment.run({
          id: t.id,
          enriched_at: now,
          ...enrich,
        });
        job.processed++;
      } catch (err) {
        console.error("[bulk-enrich] lead", t.id, "failed:", err.message);
        job.failed++;
      }
    }
    job.running = false;
    job.done = true;
    job.finishedAt = new Date().toISOString();
  });
  res.status(202).json({ success: true, job_id: job.id, total: job.total });
});

// GET /api/leads/bulk-enrich/status
router.get("/bulk-enrich/status", (req, res) => {
  if (!bulkEnrichJob) return res.json({ success: true, job: null });
  const j = bulkEnrichJob;
  res.json({
    success: true,
    job: {
      id: j.id,
      running: j.running,
      done: j.done,
      processed: j.processed,
      skipped: j.skipped,
      failed: j.failed,
      total: j.total,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
    },
  });
});

// POST /api/leads/:id/deep-summary — премиум-сводка с комментариями (Opus + YT comments)
router.post("/:id/deep-summary", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, error: "invalid id" });
  const lead = req.stmts.getLead.get(id);
  if (!lead)
    return res.status(404).json({ success: false, error: "not found" });

  try {
    const ai = require("../services/ai");
    const yt = require("../services/yt-comments");
    let videoList = [];
    try {
      videoList = JSON.parse(lead.last_videos_json || "[]");
    } catch {
      videoList = [];
    }
    if (!Array.isArray(videoList)) videoList = [];
    videoList = videoList.slice(0, 5);
    // Пробуем без API (yt-comment-scraper), fallback на YouTube API
    let comments = await yt.fetchCommentsForVideosNoApi(videoList, 10);
    const hasComments = comments.some(
      (c) => c.topComments && c.topComments.length > 0,
    );
    if (!hasComments) {
      console.log("[deep-summary] scraper пустой, fallback на YouTube API");
      comments = await yt.fetchCommentsForVideos(videoList, 10);
    }
    const summary = await ai.generateDeepSummary(lead, comments);
    const now = new Date().toISOString();
    req.stmts.updateLeadSummaryDeep.run(summary, now, id);
    res.json({ success: true, lead: req.stmts.getLead.get(id) });
  } catch (err) {
    console.error("[deep-summary]", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leads/import-from-csv  — импорт текущего output.csv
router.post("/import-from-csv", (req, res) => {
  try {
    const csvPath = path.join(__dirname, "..", "output.csv");
    const result = importFromCsv(csvPath);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/leads/:id/score — пересчитать скор одного лида
router.post("/:id/score", adminAuth, (req, res) => {
  try {
    const result = scoring.scoreLead(parseInt(req.params.id, 10));
    if (!result)
      return res.status(404).json({ success: false, error: "lead not found" });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/leads/score-all — пересчитать скоры всех лидов
router.post("/score-all", adminAuth, async (req, res) => {
  try {
    const scored = scoring.scoreAllLeads();
    res.json({ success: true, scored });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
