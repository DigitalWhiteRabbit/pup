const express = require("express");
const { getDb } = require("../db/database");
const { adminAuth } = require("../utils/auth");

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

function readFollowUp(req) {
  const row = req.stmts.getSetting.get("followup");
  let cfg = {};
  if (row && row.value) {
    try {
      cfg = JSON.parse(row.value);
    } catch {}
  }
  return {
    enabled:
      cfg.enabled !== undefined
        ? !!cfg.enabled
        : process.env.FOLLOWUP_ENABLED === "true",
    delay_days: parseInt(
      cfg.delay_days || process.env.FOLLOWUP_DELAY_DAYS || "3",
      10,
    ),
    max_attempts: parseInt(
      cfg.max_attempts || process.env.FOLLOWUP_MAX_ATTEMPTS || "2",
      10,
    ),
  };
}

// GET /api/settings — все известные настройки
router.get("/", (req, res) => {
  const reviewRow = req.stmts.getSetting.get("review_mode");
  const reviewMode = reviewRow
    ? reviewRow.value === "1" || reviewRow.value === "true"
    : process.env.REVIEW_MODE === "true" || process.env.REVIEW_MODE === "1";
  res.json({
    success: true,
    settings: { review_mode: reviewMode, followup: readFollowUp(req) },
  });
});

// POST /api/settings/review-mode { enabled: boolean }
router.post("/review-mode", (req, res) => {
  const enabled = !!req.body.enabled;
  const now = new Date().toISOString();
  req.stmts.upsertSetting.run("review_mode", enabled ? "1" : "0", now);
  res.json({ success: true, review_mode: enabled });
});

// POST /api/settings/followup { enabled?, delay_days?, max_attempts? }
router.post("/followup", (req, res) => {
  const current = readFollowUp(req);
  const next = {
    enabled:
      req.body.enabled !== undefined ? !!req.body.enabled : current.enabled,
    delay_days: Math.max(
      1,
      Math.min(30, parseInt(req.body.delay_days, 10) || current.delay_days),
    ),
    max_attempts: Math.max(
      1,
      Math.min(5, parseInt(req.body.max_attempts, 10) || current.max_attempts),
    ),
  };
  const now = new Date().toISOString();
  req.stmts.upsertSetting.run("followup", JSON.stringify(next), now);
  res.json({ success: true, followup: next });
});

module.exports = router;
