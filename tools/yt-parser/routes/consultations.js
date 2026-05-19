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

router.get("/", (req, res) => {
  const status = req.query.status;
  let rows;
  if (status) {
    rows = req.db
      .prepare(
        `
      SELECT c.*, l.channel_name, l.channel_url
      FROM consultations c
      LEFT JOIN leads l ON l.id = c.lead_id
      WHERE c.status = ?
      ORDER BY c.created_at DESC
    `,
      )
      .all(status);
  } else {
    rows = req.db
      .prepare(
        `
      SELECT c.*, l.channel_name, l.channel_url
      FROM consultations c
      LEFT JOIN leads l ON l.id = c.lead_id
      ORDER BY c.created_at DESC LIMIT 100
    `,
      )
      .all();
  }
  res.json({ success: true, consultations: rows });
});

router.post("/:id/answer", adminAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { admin_response } = req.body;
  if (!admin_response)
    return res
      .status(400)
      .json({ success: false, error: "admin_response required" });
  const now = new Date().toISOString();
  req.db
    .prepare(
      `UPDATE consultations SET admin_response = ?, status = 'answered', answered_at = ? WHERE id = ?`,
    )
    .run(admin_response, now, id);
  res.json({ success: true });
});

module.exports = router;
