const express = require("express");
const { getDb } = require("../db/database");

const router = express.Router();
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

// Цены за 1M токенов (USD). Можно переопределить через env.
const PRICE = {
  "claude-opus-4-6": {
    input: parseFloat(process.env.PRICE_OPUS_IN || "15"),
    output: parseFloat(process.env.PRICE_OPUS_OUT || "75"),
    cache_read: parseFloat(process.env.PRICE_OPUS_CREAD || "1.5"),
    cache_creation: parseFloat(process.env.PRICE_OPUS_CCREATE || "18.75"),
  },
  "claude-sonnet-4-6": {
    input: parseFloat(process.env.PRICE_SONNET_IN || "3"),
    output: parseFloat(process.env.PRICE_SONNET_OUT || "15"),
    cache_read: parseFloat(process.env.PRICE_SONNET_CREAD || "0.30"),
    cache_creation: parseFloat(process.env.PRICE_SONNET_CCREATE || "3.75"),
  },
  "claude-haiku-4-5": {
    input: parseFloat(process.env.PRICE_HAIKU_IN || "1"),
    output: parseFloat(process.env.PRICE_HAIKU_OUT || "5"),
    cache_read: parseFloat(process.env.PRICE_HAIKU_CREAD || "0.10"),
    cache_creation: parseFloat(process.env.PRICE_HAIKU_CCREATE || "1.25"),
  },
};

function priceFor(model) {
  if (!model) return PRICE["claude-sonnet-4-6"];
  return PRICE[model] || PRICE["claude-sonnet-4-6"];
}

function estimateCost(row, model) {
  const p = priceFor(model);
  const cost =
    ((row.ai_input_tokens || 0) * p.input) / 1e6 +
    ((row.ai_output_tokens || 0) * p.output) / 1e6 +
    ((row.ai_cache_read || 0) * p.cache_read) / 1e6 +
    ((row.ai_cache_creation || 0) * p.cache_creation) / 1e6;
  return cost;
}

// GET /api/health — общий чек-ап сервисов (без auth чтобы мониторинг снаружи мог пинговать)
router.get("/", async (req, res) => {
  const out = {};

  // DB
  try {
    const r = req.db.prepare("SELECT COUNT(*) AS n FROM leads").get();
    out.db = { ok: true, leads: r.n };
  } catch (e) {
    out.db = { ok: false, error: e.message };
  }

  // Anthropic
  out.anthropic = {
    ok: !!process.env.ANTHROPIC_API_KEY,
    model_main: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    model_summary: process.env.CLAUDE_MODEL_SUMMARY || "claude-haiku-4-5",
    model_complex: process.env.CLAUDE_MODEL_COMPLEX || "claude-opus-4-6",
  };

  // Resend
  out.resend = { ok: !!process.env.RESEND_API_KEY };

  // IMAP
  out.imap = {
    ok: !!(
      process.env.IMAP_HOST &&
      process.env.IMAP_USER &&
      process.env.IMAP_PASS
    ),
  };

  // Telegram outreach (user-bot)
  try {
    const tg = require("../services/telegram-outreach");
    out.telegram = { ok: tg.isReady ? tg.isReady() : false };
  } catch {
    out.telegram = { ok: false };
  }

  // Admin bot
  try {
    const adminBot = require("../services/admin-bot");
    out.admin_bot = { ok: adminBot.isReady ? adminBot.isReady() : false };
  } catch {
    out.admin_bot = { ok: false };
  }

  // Worker
  try {
    const worker = require("../services/outreach-worker");
    out.worker = worker.status ? worker.status() : { running: false };
  } catch {
    out.worker = { running: false };
  }

  // Queues
  try {
    const leadsCounts = req.stmts.countLeads.get();
    const pendingReview = req.stmts.countPendingReplies.get("pending")?.n || 0;
    const pendingDeals = req.db
      .prepare(`SELECT COUNT(*) AS n FROM deals WHERE admin_decision IS NULL`)
      .get().n;
    const pendingConsult = req.db
      .prepare(
        `SELECT COUNT(*) AS n FROM consultations WHERE status = 'pending'`,
      )
      .get().n;
    out.queues = {
      leads_pending: leadsCounts.pending || 0,
      leads_ready: leadsCounts.ready || 0,
      leads_in_work: leadsCounts.in_work || 0,
      review_pending: pendingReview,
      deals_pending: pendingDeals,
      consultations_pending: pendingConsult,
    };
  } catch (e) {
    out.queues = { error: e.message };
  }

  // Overall
  out.overall_ok =
    out.db.ok &&
    out.anthropic.ok &&
    (out.resend.ok || out.telegram.ok) &&
    !!out.worker;

  res.json({ success: true, ...out });
});

// GET /api/cost?days=30 — агрегат трат по дням
router.get("/cost", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const rows = req.db
    .prepare(`SELECT * FROM daily_counters ORDER BY date DESC LIMIT ?`)
    .all(days);
  const mainModel = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

  // Агрегаты
  let total = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_creation: 0,
    emails: 0,
    tg: 0,
    cost_usd: 0,
  };
  const byDay = rows.map((r) => {
    const cost = estimateCost(r, mainModel);
    total.input += r.ai_input_tokens || 0;
    total.output += r.ai_output_tokens || 0;
    total.cache_read += r.ai_cache_read || 0;
    total.cache_creation += r.ai_cache_creation || 0;
    total.emails += r.sent_email || 0;
    total.tg += r.sent_tg || 0;
    total.cost_usd += cost;
    return {
      date: r.date,
      input_tokens: r.ai_input_tokens || 0,
      output_tokens: r.ai_output_tokens || 0,
      cache_read: r.ai_cache_read || 0,
      cache_creation: r.ai_cache_creation || 0,
      sent_email: r.sent_email || 0,
      sent_tg: r.sent_tg || 0,
      cost_usd: Number(cost.toFixed(4)),
    };
  });

  // Сегодня
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = byDay.find((d) => d.date === today) || {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_creation: 0,
    sent_email: 0,
    sent_tg: 0,
    cost_usd: 0,
  };

  res.json({
    success: true,
    model: mainModel,
    prices: PRICE,
    today: todayRow,
    total: { ...total, cost_usd: Number(total.cost_usd.toFixed(4)) },
    by_day: byDay,
  });
});

module.exports = router;
