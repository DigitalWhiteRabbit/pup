const express = require("express");
const { stmts, db } = require("../db/database");
const { adminAuth } = require("../utils/auth");
const worker = require("../services/outreach-worker");

const router = express.Router();

router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

// GET /api/pending-replies?status=pending&limit=100&offset=0
router.get("/", (req, res) => {
  const status = req.query.status || "pending";
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const rows = stmts.listPendingReplies.all({
    status: status === "all" ? null : status,
    limit,
    offset,
  });
  const counts = {
    pending: stmts.countPendingReplies.get("pending")?.n || 0,
    approved: stmts.countPendingReplies.get("approved")?.n || 0,
    rejected: stmts.countPendingReplies.get("rejected")?.n || 0,
    sent: stmts.countPendingReplies.get("sent")?.n || 0,
    failed: stmts.countPendingReplies.get("failed")?.n || 0,
  };
  res.json({ success: true, items: rows, counts });
});

// GET /api/pending-replies/count
router.get("/count", (req, res) => {
  const pending = stmts.countPendingReplies.get("pending")?.n || 0;
  res.json({ success: true, pending });
});

// GET /api/pending-replies/:id
router.get("/:id", (req, res) => {
  const row = stmts.getPendingReply.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, item: row });
});

// POST /api/pending-replies/:id/approve { edited_body?, edited_subject?, admin_notes? }
router.post("/:id/approve", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = stmts.getPendingReply.get(id);
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
  stmts.approvePendingReply.run(editedBody, editedSubject, notes, now, id);

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
  const item = stmts.getPendingReply.get(id);
  if (!item)
    return res.status(404).json({ success: false, error: "not found" });
  if (item.status !== "pending")
    return res.status(400).json({ success: false, error: "not pending" });

  const notes = (req.body.admin_notes || "").toString().slice(0, 1000) || null;
  const now = new Date().toISOString();
  stmts.rejectPendingReply.run(notes, now, id);
  try {
    worker.onPendingReplyRejected(id);
  } catch {}
  res.json({ success: true });
});

// DELETE /api/pending-replies/:id — удалить запись из очереди (независимо от статуса)
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare("DELETE FROM pending_replies WHERE id = ?").run(id);
  res.json({ success: true });
});

// POST /api/pending-replies/purge-old — удалить sent/rejected старше 7 дней
router.post("/purge-old", (req, res) => {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const r = db
    .prepare(
      `DELETE FROM pending_replies WHERE status IN ('sent','rejected','failed') AND created_at < ?`,
    )
    .run(cutoff);
  res.json({ success: true, removed: r.changes });
});

module.exports = router;
