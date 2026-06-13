const express = require("express");
// Шаг 3.3b: роут переведён на db/prisma-store (единый Prisma-Postgres PUP).
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
const { adminAuth } = require("../utils/auth");

const router = express.Router();

router.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  return adminAuth(req, res, next);
});

async function readFollowUp(wsId) {
  const row = await store.getSetting(wsId, "followup");
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
router.get("/", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const reviewRow = await store.getSetting(req.wsId, "review_mode");
  const reviewMode = reviewRow
    ? reviewRow.value === "1" || reviewRow.value === "true"
    : process.env.REVIEW_MODE === "true" || process.env.REVIEW_MODE === "1";
  res.json({
    success: true,
    settings: {
      review_mode: reviewMode,
      followup: await readFollowUp(req.wsId),
    },
  });
});

// POST /api/settings/review-mode { enabled: boolean }
router.post("/review-mode", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const enabled = !!req.body.enabled;
  const now = new Date().toISOString();
  await store.upsertSetting(req.wsId, "review_mode", enabled ? "1" : "0", now);
  res.json({ success: true, review_mode: enabled });
});

// POST /api/settings/followup { enabled?, delay_days?, max_attempts? }
router.post("/followup", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const current = await readFollowUp(req.wsId);
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
  await store.upsertSetting(req.wsId, "followup", JSON.stringify(next), now);
  res.json({ success: true, followup: next });
});

// ─── Email config (per-workspace) ───────────────────────

const EMAIL_FIELDS = [
  "resend_api_key",
  "email_from",
  "sender_name",
  "imap_host",
  "imap_port",
  "imap_user",
  "imap_pass",
];

async function readEmailConfig(wsId) {
  const cfg = {};
  for (const field of EMAIL_FIELDS) {
    const row = await store.getSetting(wsId, `email_${field}`);
    cfg[field] = row ? row.value : "";
  }
  // Fallback to env vars if workspace has no config
  if (!cfg.resend_api_key)
    cfg.resend_api_key = process.env.RESEND_API_KEY || "";
  if (!cfg.email_from) cfg.email_from = process.env.EMAIL_FROM || "";
  if (!cfg.sender_name) cfg.sender_name = process.env.RESEND_SENDER_NAME || "";
  return cfg;
}

router.get("/email", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const cfg = await readEmailConfig(req.wsId);
  // Mask the API key for display
  const masked = { ...cfg };
  if (masked.resend_api_key) {
    masked.resend_api_key_masked =
      masked.resend_api_key.slice(0, 8) +
      "..." +
      masked.resend_api_key.slice(-4);
  }
  if (masked.imap_pass) {
    masked.imap_pass_masked = "••••••••";
  }
  res.json({ success: true, email: masked });
});

router.post("/email", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const now = new Date().toISOString();
  for (const field of EMAIL_FIELDS) {
    if (req.body[field] !== undefined) {
      await store.upsertSetting(
        req.wsId,
        `email_${field}`,
        req.body[field],
        now,
      );
    }
  }
  res.json({ success: true });
});

// Test send
router.post("/email/test", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const cfg = await readEmailConfig(req.wsId);
  if (!cfg.resend_api_key || !cfg.email_from) {
    return res.status(400).json({
      success: false,
      error: "Resend API key и Email FROM обязательны",
    });
  }
  try {
    const { Resend } = require("resend");
    const resend = new Resend(cfg.resend_api_key);
    const testTo = req.body.to || cfg.email_from; // send to self
    const result = await resend.emails.send({
      from: `${cfg.sender_name || "Test"} <${cfg.email_from}>`,
      to: [testTo],
      subject: "Test email from ПУП",
      html: "<p>Email работает! Это тестовое сообщение из парсера.</p>",
    });
    res.json({ success: true, id: result.data?.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
