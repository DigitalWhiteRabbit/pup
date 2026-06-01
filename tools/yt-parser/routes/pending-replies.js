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

  // Enrich sent items with email open tracking data
  for (const row of rows) {
    if (row.status === "sent" && row.channel === "email") {
      try {
        // Find the message created from this pending_reply (metadata contains pending_reply_id)
        const msg = req.db
          .prepare(
            `SELECT opened_at, open_count FROM messages WHERE metadata LIKE ? AND direction = 'out' LIMIT 1`,
          )
          .get(`%"pending_reply_id":${row.id}%`);
        row.msg_opened_at = msg?.opened_at || null;
        row.msg_open_count = msg?.open_count || 0;
      } catch {
        row.msg_opened_at = null;
        row.msg_open_count = 0;
      }
    } else {
      row.msg_opened_at = null;
      row.msg_open_count = 0;
    }
  }

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

  // Calculate send_after delay from project settings (random between min-max minutes)
  let ctx = {};
  try {
    ctx = JSON.parse(item.context || "{}");
  } catch {}
  const isInitial = ctx.type === "initial";
  const project = req.stmts.getActiveProject.get();
  const delayMin = project?.reply_delay_min ?? 30;
  const delayMax = project?.reply_delay_max ?? 90;

  if (!isInitial && delayMin > 0) {
    // Random delay between min and max minutes
    const delayMs =
      (delayMin + Math.random() * (delayMax - delayMin)) * 60 * 1000;
    const sendAfter = new Date(Date.now() + delayMs).toISOString();
    req.db
      .prepare("UPDATE pending_replies SET send_after = ? WHERE id = ?")
      .run(sendAfter, id);
    const delayMins = Math.round(delayMs / 60000);
    res.json({
      success: true,
      send_after: sendAfter,
      delay_minutes: delayMins,
    });
  } else {
    // Initial pitch — send immediately
    const wsId = req.workspaceId;
    setImmediate(() => {
      worker
        .processApprovedQueue(wsId)
        .catch((err) => console.error("[approve] worker error:", err.message));
    });
    res.json({ success: true, send_after: null });
  }
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

  // Reset lead so "Запустить" appears again
  if (item.lead_id) {
    req.db
      .prepare(
        `UPDATE leads SET lead_status = 'ready', dialogue_stage = 'not_contacted', locked_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, item.lead_id);
  }

  try {
    worker.onPendingReplyRejected(id);
  } catch {}
  res.json({ success: true });
});

// POST /api/pending-replies/:id/move-to-tg
// Снять письмо с очереди и пометить лида «Перешли в ТГ». В отличие от reject —
// НЕ возвращает лида в рассылку (lead_status не сбрасывается), а ставит стадию
// moved_to_tg → AI-агент перестаёт писать этому лиду, лид остаётся в базе.
router.post("/:id/move-to-tg", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = req.stmts.getPendingReply.get(id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "pending")
    return res.status(400).json({ success: false, error: "not pending" });

  const now = new Date().toISOString();
  // Снимаем письмо с очереди (rejected → уходит из «Ждут», воркер не сгенерит заново)
  req.stmts.rejectPendingReply.run("Перешли в ТГ (снято вручную)", now, id);

  // Помечаем лида «Перешли в ТГ»; в рассылку НЕ возвращаем (lead_status не трогаем)
  if (item.lead_id) {
    req.db
      .prepare(
        `UPDATE leads SET dialogue_stage = 'moved_to_tg', locked_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, item.lead_id);
  }

  try {
    worker.onPendingReplyRejected(id);
  } catch {}
  res.json({ success: true });
});

// DELETE /api/pending-replies/:id — удалить запись из очереди (независимо от статуса)
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Get lead_id before deleting so we can reset the lead
  const item = req.db
    .prepare("SELECT lead_id FROM pending_replies WHERE id = ?")
    .get(id);
  req.db.prepare("DELETE FROM pending_replies WHERE id = ?").run(id);

  // Reset lead so "Запустить" appears again
  if (item?.lead_id) {
    const now = new Date().toISOString();
    req.db
      .prepare(
        `UPDATE leads SET lead_status = 'ready', dialogue_stage = 'not_contacted', locked_until = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, item.lead_id);
  }

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

// POST /api/pending-replies/:id/translate { subject, body }
router.post("/:id/translate", async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.json({ success: true, body_ru: "", subject_ru: "" });

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic();
    const text = (subject ? `Subject: ${subject}\n\n` : "") + body;
    const r = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Переведи на русский язык. Верни ТОЛЬКО перевод, без пояснений. Если текст уже на русском — верни как есть.\n\n${text}`,
        },
      ],
    });
    const translated = r.content?.[0]?.text || "";
    // Split back subject and body if subject was included
    let subject_ru = "";
    let body_ru = translated;
    if (subject && translated.startsWith("Тема:")) {
      const parts = translated.split("\n\n");
      subject_ru = parts[0].replace(/^Тема:\s*/, "");
      body_ru = parts.slice(1).join("\n\n");
    } else if (subject && translated.includes("\n\n")) {
      const idx = translated.indexOf("\n\n");
      subject_ru = translated.slice(0, idx).replace(/^Subject:\s*/i, "");
      body_ru = translated.slice(idx + 2);
    }
    res.json({ success: true, subject_ru, body_ru });
  } catch (e) {
    res.json({
      success: true,
      subject_ru: "",
      body_ru: "(ошибка перевода: " + e.message + ")",
    });
  }
});

// POST /api/pending-replies/:id/force-send — skip timer, send immediately
router.post("/:id/force-send", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = req.db
    .prepare("SELECT * FROM pending_replies WHERE id = ?")
    .get(id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "approved")
    return res.status(400).json({ success: false, error: "not approved" });

  // Clear send_after to allow immediate processing
  req.db
    .prepare("UPDATE pending_replies SET send_after = NULL WHERE id = ?")
    .run(id);

  // Trigger processApprovedQueue
  const wsId = req.workspaceId;
  setImmediate(() => {
    worker
      .processApprovedQueue(wsId)
      .catch((err) => console.error("[force-send] error:", err.message));
  });

  res.json({ success: true });
});

// POST /api/pending-replies/:id/retry — повторная отправка письма со статусом failed
// { edited_body?, edited_subject? } — сохраняет правки из формы перед повтором
router.post("/:id/retry", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = req.db
    .prepare("SELECT * FROM pending_replies WHERE id = ?")
    .get(id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "failed")
    return res.status(400).json({ success: false, error: "not failed" });

  // Сохраняем возможные правки текста/темы из формы
  const editedBody =
    req.body.edited_body !== undefined
      ? req.body.edited_body.toString().slice(0, 20000) || null
      : item.edited_body;
  const editedSubject =
    req.body.edited_subject !== undefined
      ? req.body.edited_subject.toString().slice(0, 500) || null
      : item.edited_subject;

  // Возвращаем в approved, чистим таймер и текст ошибки → уйдёт немедленно
  const now = new Date().toISOString();
  req.db
    .prepare(
      `UPDATE pending_replies
       SET status = 'approved', send_after = NULL, admin_notes = NULL,
           edited_body = ?, edited_subject = ?, decided_at = ?
       WHERE id = ?`,
    )
    .run(editedBody, editedSubject, now, id);

  const wsId = req.workspaceId;
  setImmediate(() => {
    worker
      .processApprovedQueue(wsId)
      .catch((err) => console.error("[retry] error:", err.message));
  });

  res.json({ success: true });
});

module.exports = router;
