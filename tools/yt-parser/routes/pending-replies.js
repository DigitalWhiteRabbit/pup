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
  setImmediate(() => {
    worker
      .processApprovedQueue()
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
    // Regenerate full pitch — retry up to 3 times if AI returns garbage
    // Force a clear angle to prevent AI from requesting consultation
    const angle = `Это перегенерация — ОБЯЗАТЕЛЬНО напиши полноценный первый питч. НЕ запрашивай консультацию — канал одобрен админом.

ТРЕБОВАНИЯ К ТЕМЕ (subject):
- 3-6 слов, lowercase, без заглавных
- Конкретная отсылка к блогеру или его контенту
- Звучит как личное сообщение, НЕ как рассылка
- ЗАПРЕЩЕНО: "collab idea", "partnership opportunity", "business proposal", "for your channel"
- Хорошие примеры: "saw your mod breakdown", "BlockerLocker — quick idea", "re: your last video"

ТРЕБОВАНИЯ К ТЕКСТУ (body):
- Персонализация: упомяни конкретное видео/тему канала
- Без продажи в первом письме — только знакомство и зацеп
- Коротко, 3-4 абзаца максимум`;
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await ai.generateInitialPitch(
        lead,
        project,
        pr.channel || "email",
        angle,
      );
      // Reject empty or placeholder bodies (ignore consultation flag — body is still valid)
      const body = (r && r.body) || "";
      const isGarbage =
        !body ||
        body.length < 50 ||
        !/\n/.test(body.trim()) ||
        /ожидаю|консультац|placeholder|решения команды|релевантност|уточнен|запрос.*админ/i.test(
          body,
        );
      if (!isGarbage) {
        result = r;
        break;
      }
    }

    if (!result || !result.body || result.body.length < 20) {
      return res.status(500).json({
        success: false,
        error:
          "AI не смог сгенерировать нормальное письмо. Попробуйте ещё раз.",
      });
    }

    const newSubject = result.subject || pr.subject;
    const newBody = result.body;

    const response = { success: true };

    if (field === "subject") {
      // Only update subject, keep existing body
      req.db
        .prepare("UPDATE pending_replies SET subject = ? WHERE id = ?")
        .run(newSubject, id);
      response.subject = newSubject;
    } else if (field === "body") {
      // Only update body, keep existing subject
      req.db
        .prepare("UPDATE pending_replies SET body = ? WHERE id = ?")
        .run(newBody, id);
      response.body = newBody;
    } else {
      // "both" — update everything
      req.db
        .prepare(
          "UPDATE pending_replies SET subject = ?, body = ? WHERE id = ?",
        )
        .run(newSubject, newBody, id);
      response.subject = newSubject;
      response.body = newBody;
    }

    res.json(response);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
