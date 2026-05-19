const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const worker = require("../services/outreach-worker");
const { adminAuth } = require("../utils/auth");
const { getDb } = require("../db/database");
const ai = require("../services/ai");
const kn = require("../services/knowledge");
const Anthropic = require("@anthropic-ai/sdk");
const router = express.Router();
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

const AVATAR_DIR = path.join(__dirname, "..", "data");
const AVATAR_PATH = path.join(AVATAR_DIR, "agent-avatar.png");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.get("/status", (req, res) => {
  res.json({ success: true, ...worker.status() });
});

router.post("/start", adminAuth, (req, res) => {
  worker.start();
  res.json({ success: true, ...worker.status() });
});

router.post("/stop", adminAuth, (req, res) => {
  worker.stop();
  res.json({ success: true, ...worker.status() });
});

router.get("/logs", (req, res) => {
  res.json({ success: true, logs: worker.getLogs() });
});

// Force-tick once (for manual testing)
router.post("/tick", adminAuth, async (req, res) => {
  try {
    await worker.processOutreachQueue();
    await worker.processInbox();
    res.json({ success: true, ...worker.status() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Live chat: тестовый чат оператора с агентом (знания о проекте) ───
// POST /api/agent/chat  { message, history?: [{role:'user'|'assistant', content}] }
let anthropicClient = null;
function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY не задан");
  anthropicClient = new Anthropic({ apiKey, maxRetries: 2 });
  return anthropicClient;
}

function sanitize(v, n = 300) {
  return v == null ? "" : String(v).slice(0, n);
}
function sanitizeLong(v, n = 2000) {
  return v == null ? "" : String(v).replace(/\r/g, "").slice(0, n);
}

router.post("/chat", async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (!message || !String(message).trim()) {
      return res
        .status(400)
        .json({ success: false, error: "message обязателен" });
    }
    const userMsg = String(message).slice(0, 4000);

    const project = req.stmts.getActiveProject.get(); // может быть null — чат всё равно работает
    const pid = project ? project.id : null;

    // RAG: top-8 чанков под вопрос (если активной кампании нет — ищем по всей базе)
    let knowledgeBlock = "";
    let sources = [];
    try {
      const hits = await kn.searchKnowledge(pid, userMsg, 8);
      if (hits && hits.length) {
        knowledgeBlock =
          "═══ РЕЛЕВАНТНЫЕ ЗНАНИЯ ═══\n" +
          hits
            .map(
              (h, i) =>
                `[${i + 1}] ${h.title || "(без названия)"}\n${sanitizeLong(h.chunk_text, 1400)}`,
            )
            .join("\n\n");
        sources = hits.map((h) => ({
          doc_id: h.doc_id,
          title: h.title,
          snippet: sanitizeLong(h.chunk_text, 240),
        }));
      }
    } catch (e) {
      console.error("[chat rag]", e.message);
    }

    // System prompt — работает с проектом или без него
    const systemBase = `Ты — AI-ассистент${project ? ' проекта "' + sanitize(project.name, 100) + '"' : ""}. Общаешься с ОПЕРАТОРОМ (администратором), а не с блогером.
Задача: точно и кратко отвечать на вопросы, основываясь на переданных знаниях из базы.
Если в блоке «РЕЛЕВАНТНЫЕ ЗНАНИЯ» нет ответа — честно скажи «в базе знаний этого нет» и не выдумывай.
Можешь ссылаться на источники номером в квадратных скобках [1], [2] — оператор увидит их отдельно.
Отвечай на русском, если вопрос на русском. Коротко и по делу, без воды.`;

    const projectCtx = project
      ? `═══ ПРОЕКТ ═══
Название: ${sanitize(project.name, 100)}
${project.value_prop_short ? "Value prop: " + sanitize(project.value_prop_short, 250) + "\n" : ""}Описание: ${sanitize(project.description, 1200)}
${project.unique_selling_points ? "УТП: " + sanitize(project.unique_selling_points, 500) + "\n" : ""}${project.target_audience ? "ЦА: " + sanitize(project.target_audience, 300) + "\n" : ""}${project.ideal_channel_profile ? "Идеальный профиль канала: " + sanitize(project.ideal_channel_profile, 600) + "\n" : ""}${project.bad_fit_examples ? "НЕ подходит: " + sanitize(project.bad_fit_examples, 500) + "\n" : ""}${project.proof_points ? "Proof points: " + sanitize(project.proof_points, 600) + "\n" : ""}${project.creator_economics ? "Экономика блогера: " + sanitize(project.creator_economics, 400) + "\n" : ""}${project.cta_text ? "CTA: " + sanitize(project.cta_text, 200) + (project.cta_link ? " — " + sanitize(project.cta_link, 300) : "") + "\n" : ""}${project.tone_of_voice ? "Tone of voice: " + sanitize(project.tone_of_voice, 300) + "\n" : ""}`
      : "";

    const system = [
      { type: "text", text: systemBase, cache_control: { type: "ephemeral" } },
      ...(projectCtx ? [{ type: "text", text: projectCtx }] : []),
      ...(knowledgeBlock ? [{ type: "text", text: knowledgeBlock }] : []),
    ];

    // История: отфильтровать и санитайзнуть
    const safeHistory = Array.isArray(history)
      ? history
          .slice(-20)
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: sanitizeLong(m.content, 4000),
          }))
          .filter((m) => m.content)
      : [];
    const messages = [...safeHistory, { role: "user", content: userMsg }];

    const client = getAnthropic();
    const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      temperature: 0.4,
      system,
      messages,
    });
    const textBlock = (response.content || []).find((b) => b.type === "text");
    const reply = textBlock ? textBlock.text : "(пустой ответ)";

    res.json({ success: true, reply, sources, usage: response.usage });
  } catch (e) {
    console.error("[chat]", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Agent profile: аватар и статистика для Live чата ──────────────

// GET /api/agent/avatar — отдаёт файл или 404
router.get("/avatar", (req, res) => {
  if (!fs.existsSync(AVATAR_PATH)) return res.status(404).end();
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(AVATAR_PATH);
});

// POST /api/agent/avatar (multipart, field "file")
router.post("/avatar", upload.single("file"), (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "file обязателен" });
    if (!/^image\//.test(req.file.mimetype)) {
      return res
        .status(400)
        .json({ success: false, error: "только изображения" });
    }
    if (!fs.existsSync(AVATAR_DIR))
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
    fs.writeFileSync(AVATAR_PATH, req.file.buffer);
    res.json({ success: true, size: req.file.size, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete("/avatar", (req, res) => {
  try {
    if (fs.existsSync(AVATAR_PATH)) fs.unlinkSync(AVATAR_PATH);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/agent/stats — статистика диалогов для правой панели
router.get("/stats", (req, res) => {
  try {
    const row =
      req.db
        .prepare(
          `
      SELECT
        SUM(CASE WHEN dialogue_stage NOT IN ('not_contacted') THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN dialogue_stage IN ('deal_closed','disqualified','dead','declined','closed_won','closed_lost','deal_pending') THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN dialogue_stage IN ('in_work','negotiating','awaiting_reply','followup_1','followup_2','queued','replied') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN dialogue_stage = 'awaiting_review' THEN 1 ELSE 0 END) AS pending
      FROM leads
    `,
        )
        .get() || {};
    res.json({
      success: true,
      total: row.total || 0,
      completed: row.completed || 0,
      active: row.active || 0,
      pending: row.pending || 0,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
