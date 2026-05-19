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
    // Always regenerate full pitch (AI needs body context for good subject)
    const result = await ai.generateInitialPitch(
      lead,
      project,
      pr.channel || "email",
    );

    if (!result || (!result.subject && !result.body)) {
      return res
        .status(500)
        .json({ success: false, error: "AI returned empty result" });
    }

    const newSubject = result.subject || pr.subject;
    const newBody = result.body || pr.body;

    // Always update both in DB to keep them in sync
    req.db
      .prepare("UPDATE pending_replies SET subject = ?, body = ? WHERE id = ?")
      .run(newSubject, newBody, id);

    // Return what the frontend asked for
    const response = { success: true };
    if (field === "subject" || field === "both") response.subject = newSubject;
    if (field === "body" || field === "both") response.body = newBody;
    // For subject-only: also return body so frontend can update if it wants
    if (field === "subject") response.body = newBody;

    res.json(response);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
