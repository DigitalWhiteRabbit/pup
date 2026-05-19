const express = require("express");
const { getDb } = require("../db/database");
const { adminAuth } = require("../utils/auth");
const worker = require("../services/outreach-worker");

const router = express.Router();

router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

// GET /api/pending-replies?status=pending&limit=100&offset=0
router.get("/", (req, res) => {
  const status = req.query.status || "pending";
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const rows = req.stmts.listPendingReplies.all({
    status: status === "all" ? null : status,
    limit,
    offset,
  });
  const counts = {
    pending: req.stmts.countPendingReplies.get("pending")?.n || 0,
    approved: req.stmts.countPendingReplies.get("approved")?.n || 0,
    rejected: req.stmts.countPendingReplies.get("rejected")?.n || 0,
    sent: req.stmts.countPendingReplies.get("sent")?.n || 0,
    failed: req.stmts.countPendingReplies.get("failed")?.n || 0,
  };
  res.json({ success: true, items: rows, counts });
});

// GET /api/pending-replies/count
router.get("/count", (req, res) => {
  const pending = req.stmts.countPendingReplies.get("pending")?.n || 0;
  res.json({ success: true, pending });
});

// GET /api/pending-replies/:id
router.get("/:id", (req, res) => {
  const row = req.stmts.getPendingReply.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, item: row });
});

// POST /api/pending-replies/:id/approve { edited_body?, edited_subject?, admin_notes? }
router.post("/:id/approve", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = req.stmts.getPendingReply.get(id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "pending")
    return res.status(400).json({ success: false, error: "not pending" });

  const editedBody =
    (req.body.edited_body || "").toString().slice(0, 20000) || null;
  const editedSubject =
    (req.body.edited_subject || "").toString().slice(0, 500) || null;
  const notes = (req.body.admin_notes || "").toString().slice(0, 1000) || null;
  const now = new Date().toISOString();
  req.stmts.approvePendingReply.run(editedBody, editedSubject, notes, now, id);

  // Немедленно запустить processApprovedQueue (не ждать 20с тика)
  const wsId = req.workspaceId;
  setImmediate(() => {
    worker
      .processApprovedQueue(wsId)
      .catch((err) => console.error("[approve] worker error:", err.message));
  });

  res.json({ success: true });
});

// POST /api/pending-replies/:id/reject { admin_notes? }
router.post("/:id/reject", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = req.stmts.getPendingReply.get(id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "pending")
    return res.status(400).json({ success: false, error: "not pending" });

  const notes = (req.body.admin_notes || "").toString().slice(0, 1000) || null;
  const now = new Date().toISOString();
  req.stmts.rejectPendingReply.run(notes, now, id);
  try {
    worker.onPendingReplyRejected(id);
  } catch {}
  res.json({ success: true });
});

// DELETE /api/pending-replies/:id — удалить запись из очереди (независимо от статуса)
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  req.db.prepare("DELETE FROM pending_replies WHERE id = ?").run(id);
  res.json({ success: true });
});

// POST /api/pending-replies/purge-old — удалить sent/rejected старше 7 дней
router.post("/purge-old", (req, res) => {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = req.db
    .prepare(
      `DELETE FROM pending_replies WHERE status IN ('sent','rejected','failed') AND created_at < ?`,
    )
    .run(cutoff);
  res.json({ success: true, removed: r.changes });
});

// POST /api/pending-replies/:id/regenerate { field: "subject"|"body"|"both" }
router.post("/:id/regenerate", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const field = req.body.field || "both";
  const pr = req.db
    .prepare("SELECT * FROM pending_replies WHERE id = ?")
    .get(id);
  if (!pr) return res.status(404).json({ success: false, error: "not found" });

  const lead = req.stmts.getLead.get(pr.lead_id);
  const project = req.stmts.getActiveProject.get();
  if (!lead || !project)
    return res
      .status(400)
      .json({ success: false, error: "lead or project not found" });

  try {
    const ai = require("../services/ai");
    const angle = `Это перегенерация — напиши полноценный первый питч. Канал одобрен админом.`;

    // Try up to 3 times
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await ai.generateInitialPitch(
        lead,
        project,
        pr.channel || "email",
        angle,
      );
      if (!r) continue;

      // For subject-only: we only need a good subject
      if (field === "subject") {
        if (r.subject && r.subject.length >= 5) {
          result = r;
          break;
        }
        continue;
      }

      // For body or both: validate body quality
      const body = r.body || "";
      const badBody =
        body.length < 50 ||
        !/\n/.test(body.trim()) ||
        /ожидаю|консультац|placeholder|решения команды|релевантност|уточнен|запрос.*админ/i.test(
          body,
        );
      if (!badBody) {
        result = r;
        break;
      }
    }

    if (!result) {
      return res.status(500).json({
        success: false,
        error: "AI не смог сгенерировать. Попробуйте ещё раз.",
      });
    }

    const response = { success: true };

    if (field === "subject") {
      const subj = result.subject || pr.subject;
      req.db
        .prepare("UPDATE pending_replies SET subject = ? WHERE id = ?")
        .run(subj, id);
      response.subject = subj;
    } else if (field === "body") {
      req.db
        .prepare("UPDATE pending_replies SET body = ? WHERE id = ?")
        .run(result.body, id);
      response.body = result.body;
    } else {
      const subj = result.subject || pr.subject;
      req.db
        .prepare(
          "UPDATE pending_replies SET subject = ?, body = ? WHERE id = ?",
        )
        .run(subj, result.body, id);
      response.subject = subj;
      response.body = result.body;
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/pending-replies/:id/lead-context — full AI context for this lead
router.get("/:id/lead-context", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pr = req.db
    .prepare("SELECT * FROM pending_replies WHERE id = ?")
    .get(id);
  if (!pr) return res.status(404).json({ success: false, error: "not found" });

  const lead = req.stmts.getLead.get(pr.lead_id);
  if (!lead)
    return res.status(404).json({ success: false, error: "lead not found" });

  // Parse content_summary
  let summary = {};
  try {
    summary = JSON.parse(lead.content_summary || "{}");
  } catch {}

  // Parse videos
  let videos = [];
  try {
    videos = JSON.parse(lead.last_videos_json || "[]");
  } catch {}

  // Parse contacts
  let contacts = {};
  try {
    contacts = JSON.parse(lead.raw_contacts || "{}");
  } catch {}

  res.json({
    success: true,
    context: {
      channel_name: lead.channel_name,
      channel_url: lead.channel_url,
      subscribers: lead.subscribers,
      avg_views: lead.avg_views,
      engagement_rate: lead.engagement_rate,
      country: lead.country,
      channel_language: lead.channel_language,
      main_category: lead.main_category,
      keyword: lead.keyword,
      channel_about: lead.channel_about_text,
      channel_tags: lead.channel_tags,
      channel_age_days: lead.channel_age_days,
      // Parsed summary
      niche: summary.niche,
      content_style: summary.content_style,
      audience: summary.audience,
      tone: summary.tone,
      recent_topics: summary.recent_topics || [],
      pitch_hooks: summary.pitch_hooks || [],
      red_flags: summary.red_flags || [],
      // Videos
      recent_videos: (videos || []).slice(0, 5).map((v) => ({
        title: v.title,
        views: v.views,
        published: v.publishedAt,
      })),
      // Contacts
      email: lead.email,
      telegram: lead.telegram,
      contacts,
      // Scores
      lead_score: lead.lead_score,
      score_breakdown: lead.score_breakdown,
    },
  });
});

module.exports = router;
