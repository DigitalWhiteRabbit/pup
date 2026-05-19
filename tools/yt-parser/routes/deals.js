const express = require("express");
const { getDb } = require("../db/database");
const { adminAuth } = require("../utils/auth");
const router = express.Router();
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

// GET /api/deals?status=pending|approved|rejected
router.get("/", (req, res) => {
  const status = req.query.status;
  let rows;
  if (status === "pending") {
    rows = req.stmts.listPendingDeals.all();
  } else if (status) {
    rows = req.db
      .prepare(
        `
      SELECT d.*, l.channel_name, l.subscribers, l.country, l.channel_url, l.thumbnail
      FROM deals d JOIN leads l ON l.id = d.lead_id
      WHERE d.admin_decision = ?
      ORDER BY d.created_at DESC
    `,
      )
      .all(status);
  } else {
    rows = req.db
      .prepare(
        `
      SELECT d.*, l.channel_name, l.subscribers, l.country, l.channel_url, l.thumbnail
      FROM deals d JOIN leads l ON l.id = d.lead_id
      ORDER BY d.created_at DESC
    `,
      )
      .all();
  }
  res.json({ success: true, deals: rows });
});

// POST /api/deals/:id/approve  { notes? }
router.post("/:id/approve", adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const now = new Date().toISOString();
  req.stmts.decideDeal.run("approved", req.body.notes || null, now, id);
  res.json({ success: true });
});

router.post("/:id/reject", adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const now = new Date().toISOString();
  req.stmts.decideDeal.run("rejected", req.body.notes || null, now, id);
  res.json({ success: true });
});

module.exports = router;
