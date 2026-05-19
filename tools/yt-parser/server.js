const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const leadsRouter = require("./routes/leads");
const projectsRouter = require("./routes/projects");
const dialoguesRouter = require("./routes/dialogues");
const agentRouter = require("./routes/agent");
const telegramRouter = require("./routes/telegram");
const dealsRouter = require("./routes/deals");
const consultationsRouter = require("./routes/consultations");
const pendingRepliesRouter = require("./routes/pending-replies");
const settingsRouter = require("./routes/settings");
const healthRouter = require("./routes/health");
const knowledgeRouter = require("./routes/knowledge");
const devTasksRouter = require("./routes/dev-tasks");
const { adminAuth } = require("./utils/auth");
const { authGate } = require("./utils/session");
const authRouter = require("./routes/auth");
const unsubscribeRouter = require("./routes/unsubscribe");
const { importFromCsv } = require("./db/lead-importer");
const tgOutreach = require("./services/telegram-outreach");
const adminBot = require("./services/admin-bot");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

// Auth routes (открытые) — до gate
app.use("/api/auth", authRouter);

// Unsubscribe (открытый) — до gate, кликают блогеры без аутентификации
app.use("/unsubscribe", unsubscribeRouter);

// Gate: редиректит неавторизованных на /login.html, пропускает ADMIN_TOKEN и /api/auth/*
// app.use(authGate); // disabled — PUP handles auth via nginx

app.use(express.static(path.join(__dirname, "public")));

// New API routers
app.use("/api/leads", leadsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/dialogues", dialoguesRouter);
app.use("/api/agent", agentRouter);
app.use("/api/telegram", telegramRouter);
app.use("/api/deals", dealsRouter);
app.use("/api/consultations", consultationsRouter);
app.use("/api/pending-replies", pendingRepliesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/health", healthRouter);
app.use("/api/knowledge", knowledgeRouter);
app.use("/api/dev-tasks", devTasksRouter);

const ARCHIVE_DIR = path.join(__dirname, "Архив парсинг");
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const OUTPUT_CSV = path.join(ARCHIVE_DIR, "output.csv");
const CACHE_FILE = path.join(__dirname, "cache.json");
const ERROR_LOG = path.join(__dirname, "errors.log");
const DELETED_FILE = path.join(__dirname, "deleted.json");
const PRESETS_FILE = path.join(__dirname, "presets.json");
const HISTORY_FILE = path.join(__dirname, "history.json");

// Миграция: если старый output.csv лежит в root — мерджим с архивным (а не overwrite),
// чтобы не потерять контакты из любого источника.
const LEGACY_CSV = path.join(__dirname, "output.csv");
if (fs.existsSync(LEGACY_CSV)) {
  try {
    const { parseCsv } = require("./utils/csv");
    const { createObjectCsvWriter } = require("csv-writer");
    const legacyRows = parseCsv(LEGACY_CSV);
    const archiveRows = fs.existsSync(OUTPUT_CSV) ? parseCsv(OUTPUT_CSV) : [];
    const seen = new Set();
    const merged = [];
    for (const row of [...archiveRows, ...legacyRows]) {
      const id = row.channel_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
    }
    if (merged.length > 0) {
      const header = Object.keys(merged[0]).map((k) => ({ id: k, title: k }));
      const writer = createObjectCsvWriter({ path: OUTPUT_CSV, header });
      writer.writeRecords(merged).then(() => {
        try {
          fs.unlinkSync(LEGACY_CSV);
        } catch {}
        console.log(
          `[migrate] merged ${legacyRows.length} legacy + ${archiveRows.length} archive → ${merged.length} unique rows`,
        );
      });
    } else {
      try {
        fs.unlinkSync(LEGACY_CSV);
      } catch {}
    }
  } catch (e) {
    console.error("[migrate] failed:", e.message);
  }
}

function loadJson(file, fallback) {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return fallback;
    }
  }
  return fallback;
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function loadDeleted() {
  if (fs.existsSync(DELETED_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DELETED_FILE, "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}
function saveDeleted(ids) {
  fs.writeFileSync(DELETED_FILE, JSON.stringify(ids, null, 2), "utf-8");
}

// ─── Состояние парсера ──────────────────────────────────────────────────────

let parserState = {
  status: "idle", // idle | running | done | error
  process: null,
  log: [],
  error: null,
};

// SSE клиенты
let sseClients = [];

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((res) => {
    try {
      res.write(msg);
      return true;
    } catch {
      return false;
    }
  });
}

// ─── Парсинг CSV ────────────────────────────────────────────────────────────

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  // Split into logical CSV rows (handles multiline quoted fields)
  const rows = splitCsvRows(content);
  if (rows.length < 2) return [];

  const headers = parseCSVLine(rows[0]);
  const results = [];

  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (!line.trim()) continue;
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    row.subscribers = parseInt(row.subscribers, 10) || 0;
    row.total_views = parseInt(row.total_views, 10) || 0;
    row.video_count = parseInt(row.video_count, 10) || 0;
    row.avg_views_per_video = parseInt(row.avg_views_per_video, 10) || 0;
    row.engagement_rate = parseFloat(row.engagement_rate) || 0;
    // Ensure contact fields exist (backward compat with old CSVs)
    for (const f of [
      "telegram",
      "instagram",
      "twitter",
      "tiktok",
      "vk",
      "discord",
      "whatsapp",
      "website",
    ]) {
      if (row[f] === undefined) row[f] = "";
    }
    results.push(row);
  }
  return results;
}

function splitCsvRows(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '""';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
        current += ch;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        current += ch;
      } else if (ch === "\n") {
        rows.push(current);
        current = "";
      } else if (ch === "\r") {
        // skip
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) rows.push(current);
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ─── API Endpoints ──────────────────────────────────────────────────────────

// Получить результаты из CSV + обогащение lead_status из БД
app.get("/api/results", (req, res) => {
  try {
    const data = parseCsv(OUTPUT_CSV);
    // Join с leads DB по channel_id
    try {
      const { db } = require("./db/database");
      const leadRows = db
        .prepare(
          "SELECT id, channel_id, lead_status, dialogue_stage, lead_score, shorts_ratio, er_normalized, engagement_rate FROM leads",
        )
        .all();
      const byChannelId = {};
      for (const l of leadRows) byChannelId[l.channel_id] = l;
      for (const row of data) {
        const l = row.channel_id ? byChannelId[row.channel_id] : null;
        row.lead_id = l ? l.id : null;
        row.lead_status = l ? l.lead_status : "pending";
        row.dialogue_stage = l ? l.dialogue_stage : "not_contacted";
        row.lead_score = l ? l.lead_score : null;
        row.shorts_ratio = l ? l.shorts_ratio : null;
        row.er_normalized = l ? l.er_normalized : null;
      }
    } catch {}
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// Квота
app.get("/api/quota", (req, res) => {
  try {
    let used = 0;
    if (fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      used = cache.apiUnitsUsed || 0;
    }
    res.json({
      success: true,
      used,
      total: 10000,
      remaining: Math.max(0, 10000 - used),
    });
  } catch {
    res.json({ success: true, used: 0, total: 10000, remaining: 10000 });
  }
});

// Статус парсера
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    status: parserState.status,
    error: parserState.error,
    logLength: parserState.log.length,
  });
});

// Запустить парсер
app.post("/api/parse", adminAuth, (req, res) => {
  if (parserState.status === "running") {
    return res
      .status(409)
      .json({ success: false, error: "Парсер уже запущен" });
  }

  const {
    keywords,
    hashtags,
    minSubs,
    maxSubs,
    minEngagement,
    country,
    activeDays,
    limit,
    append,
    category,
    sortBy,
    language,
    region,
    publishedAfter,
    videoDuration,
    requireContacts,
  } = req.body;

  if (!keywords && !hashtags) {
    return res
      .status(400)
      .json({ success: false, error: "Укажите keywords или hashtags" });
  }

  // Собираем аргументы для CLI
  const args = [];
  if (keywords) args.push("--keywords", keywords);
  if (hashtags) args.push("--hashtags", hashtags);
  if (minSubs) args.push("--min-subs", String(minSubs));
  if (maxSubs) args.push("--max-subs", String(maxSubs));
  if (minEngagement) args.push("--min-engagement", String(minEngagement));
  if (country) args.push("--country", country);
  if (activeDays) args.push("--active-days", String(activeDays));
  if (limit) args.push("--limit", String(limit));
  // Всегда append: новые каналы добавляются к существующим, дубликаты игнорируются
  args.push("--append");
  // Пишем туда же, откуда читает /api/results (Архив парсинг/output.csv).
  // Без этого парсер писал в <root>/output.csv, а dashboard читал из архива → казалось что старые контакты пропали.
  args.push("--output", OUTPUT_CSV);
  if (category) args.push("--category", String(category));
  if (sortBy) args.push("--sort-by", sortBy);
  if (language) args.push("--language", language);
  if (region) args.push("--region", region);
  if (publishedAfter) args.push("--published-after", publishedAfter);
  if (videoDuration) args.push("--video-duration", videoDuration);
  if (requireContacts === false) args.push("--no-require-contacts");

  // Dynamic search pages: more pages for higher limits
  const searchPages = Math.max(10, Math.ceil((limit || 50) / 5));
  args.push("--max-search-pages", String(Math.min(searchPages, 50)));
  // Передаём удалённые каналы
  const deletedIds = loadDeleted();
  if (deletedIds.length > 0) args.push("--skip-channels", deletedIds.join(","));

  parserState.status = "running";
  parserState.log = [];
  parserState.error = null;
  parserState.startedAt = new Date().toISOString();
  parserState.params = {
    keywords,
    hashtags,
    minSubs,
    maxSubs,
    minEngagement,
    country,
    activeDays,
    limit,
    category,
    sortBy,
    language,
    region,
    publishedAfter,
  };

  broadcast("status", { status: "running" });

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "index.js"), ...args],
    {
      cwd: __dirname,
      env: { ...process.env },
    },
  );

  parserState.process = child;

  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      parserState.log.push(line);
      broadcast("log", { message: line });
    }
  });

  child.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      parserState.log.push(`[ERR] ${line}`);
      broadcast("log", { message: `[ERR] ${line}` });
    }
  });

  child.on("close", (code) => {
    parserState.process = null;
    const finishedAt = new Date().toISOString();
    let importResult = null;
    if (code === 0) {
      parserState.status = "done";
      // Лиды НЕ импортируются автоматически — только при клике «→ В работу» на Dashboard
      broadcast("status", { status: "done" });
    } else {
      parserState.status = "error";
      parserState.error = `Процесс завершился с кодом ${code}`;
      broadcast("status", { status: "error", error: parserState.error });
    }
    // Save to history
    const history = loadJson(HISTORY_FILE, []);
    const resultCount = fs.existsSync(OUTPUT_CSV)
      ? parseCsv(OUTPUT_CSV).length
      : 0;
    history.unshift({
      id: Date.now(),
      startedAt: parserState.startedAt,
      finishedAt,
      status: parserState.status,
      error: parserState.error,
      params: parserState.params,
      resultCount,
    });
    if (history.length > 50) history.length = 50; // keep last 50
    saveJson(HISTORY_FILE, history);
  });

  child.on("error", (err) => {
    parserState.process = null;
    parserState.status = "error";
    parserState.error = err.message;
    broadcast("status", { status: "error", error: err.message });
  });

  res.json({ success: true, message: "Парсер запущен" });
});

// Остановить парсер
app.post("/api/stop", adminAuth, (req, res) => {
  if (parserState.status !== "running" || !parserState.process) {
    return res.status(400).json({ success: false, error: "Парсер не запущен" });
  }

  parserState.process.kill("SIGTERM");
  parserState.status = "idle";
  parserState.process = null;
  broadcast("status", { status: "idle" });

  res.json({ success: true, message: "Парсер остановлен" });
});

// Логи ошибок
app.get("/api/logs", (req, res) => {
  try {
    if (!fs.existsSync(ERROR_LOG)) {
      return res.json({ success: true, lines: [] });
    }
    const content = fs.readFileSync(ERROR_LOG, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean).slice(-50);
    res.json({ success: true, lines });
  } catch {
    res.json({ success: true, lines: [] });
  }
});

// Очистить результаты
app.delete("/api/results", adminAuth, (req, res) => {
  try {
    if (fs.existsSync(OUTPUT_CSV)) fs.unlinkSync(OUTPUT_CSV);
    res.json({ success: true, message: "Данные очищены" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Удалённые каналы
app.get("/api/deleted", (req, res) => {
  res.json({ success: true, ids: loadDeleted() });
});

app.post("/api/deleted", adminAuth, (req, res) => {
  const { channelId } = req.body;
  if (!channelId)
    return res
      .status(400)
      .json({ success: false, error: "channelId required" });
  const ids = loadDeleted();
  if (!ids.includes(channelId)) {
    ids.push(channelId);
    saveDeleted(ids);
  }
  res.json({ success: true });
});

app.delete("/api/deleted/:channelId", adminAuth, (req, res) => {
  const ids = loadDeleted().filter((id) => id !== req.params.channelId);
  saveDeleted(ids);
  res.json({ success: true });
});

// Скачать CSV
app.get("/api/download", (req, res) => {
  if (!fs.existsSync(OUTPUT_CSV)) {
    return res.status(404).json({ success: false, error: "Файл не найден" });
  }
  res.download(OUTPUT_CSV, "youtube_bloggers.csv");
});

// ─── Presets ────────────────────────────────────────────────────────────────

app.get("/api/presets", (req, res) => {
  res.json({ success: true, presets: loadJson(PRESETS_FILE, []) });
});

app.post("/api/presets", adminAuth, (req, res) => {
  const { name, params } = req.body;
  if (!name)
    return res.status(400).json({ success: false, error: "name required" });
  const presets = loadJson(PRESETS_FILE, []);
  const existing = presets.findIndex((p) => p.name === name);
  if (existing >= 0)
    presets[existing] = { name, params, updatedAt: new Date().toISOString() };
  else presets.push({ name, params, createdAt: new Date().toISOString() });
  saveJson(PRESETS_FILE, presets);
  res.json({ success: true });
});

app.delete("/api/presets/:name", adminAuth, (req, res) => {
  const presets = loadJson(PRESETS_FILE, []).filter(
    (p) => p.name !== req.params.name,
  );
  saveJson(PRESETS_FILE, presets);
  res.json({ success: true });
});

// ─── History ────────────────────────────────────────────────────────────────

app.get("/api/history", (req, res) => {
  res.json({ success: true, history: loadJson(HISTORY_FILE, []) });
});

app.delete("/api/history", adminAuth, (req, res) => {
  saveJson(HISTORY_FILE, []);
  res.json({ success: true });
});

// ─── Analytics ──────────────────────────────────────────────────────────────

app.get("/api/analytics", (req, res) => {
  const data = parseCsv(OUTPUT_CSV);
  if (data.length === 0) return res.json({ success: true, analytics: null });

  // Engagement benchmarks by subscriber tier
  const tiers = [
    { name: "Nano (<10K)", min: 0, max: 10000 },
    { name: "Micro (10-50K)", min: 10000, max: 50000 },
    { name: "Mid (50-200K)", min: 50000, max: 200000 },
    { name: "Macro (200-500K)", min: 200000, max: 500000 },
    { name: "Mega (500K+)", min: 500000, max: Infinity },
  ];
  const tierStats = tiers.map((t) => {
    const channels = data.filter(
      (d) => d.subscribers >= t.min && d.subscribers < t.max,
    );
    const avgEng =
      channels.length > 0
        ? channels.reduce((s, d) => s + d.engagement_rate, 0) / channels.length
        : 0;
    const avgViews =
      channels.length > 0
        ? Math.round(
            channels.reduce((s, d) => s + d.avg_views_per_video, 0) /
              channels.length,
          )
        : 0;
    return {
      name: t.name,
      count: channels.length,
      avgEngagement: parseFloat((avgEng * 100).toFixed(2)),
      avgViews,
    };
  });

  // Country distribution
  const countries = {};
  data.forEach((d) => {
    const c = d.country || "Unknown";
    countries[c] = (countries[c] || 0) + 1;
  });
  const countryDist = Object.entries(countries)
    .map(([country, count]) => ({ country, count }))
    .sort((a, b) => b.count - a.count);

  // Contact coverage
  const contactFields = [
    "email",
    "telegram",
    "instagram",
    "twitter",
    "tiktok",
    "vk",
    "discord",
    "whatsapp",
    "website",
  ];
  const contactCoverage = {};
  contactFields.forEach((f) => {
    contactCoverage[f] = data.filter((d) => d[f] && d[f].trim()).length;
  });
  const anyContact = data.filter((d) =>
    contactFields.some((f) => d[f] && d[f].trim()),
  ).length;
  contactCoverage.any = anyContact;

  // Top channels by different metrics
  const topByEngagement = [...data]
    .sort((a, b) => b.engagement_rate - a.engagement_rate)
    .slice(0, 10);
  const topBySubscribers = [...data]
    .sort((a, b) => b.subscribers - a.subscribers)
    .slice(0, 10);
  const topByAvgViews = [...data]
    .sort((a, b) => b.avg_views_per_video - a.avg_views_per_video)
    .slice(0, 10);

  // Estimated CPM ranges (rough industry averages)
  const estimatedCosts = data
    .map((d) => {
      const avgV = d.avg_views_per_video;
      let cpmMin = 50,
        cpmMax = 200; // RUB
      if (d.subscribers > 500000) {
        cpmMin = 100;
        cpmMax = 400;
      } else if (d.subscribers > 100000) {
        cpmMin = 80;
        cpmMax = 300;
      } else if (d.subscribers > 10000) {
        cpmMin = 50;
        cpmMax = 200;
      } else {
        cpmMin = 30;
        cpmMax = 150;
      }
      return {
        channel_name: d.channel_name,
        subscribers: d.subscribers,
        avg_views: avgV,
        estimated_cost_min: Math.round((avgV / 1000) * cpmMin),
        estimated_cost_max: Math.round((avgV / 1000) * cpmMax),
      };
    })
    .sort((a, b) => b.avg_views - a.avg_views);

  // Keyword effectiveness
  const keywordStats = {};
  data.forEach((d) => {
    if (!d.keyword) return;
    d.keyword.split(";").forEach((k) => {
      k = k.trim();
      if (!k) return;
      if (!keywordStats[k])
        keywordStats[k] = { count: 0, totalEng: 0, totalSubs: 0 };
      keywordStats[k].count++;
      keywordStats[k].totalEng += d.engagement_rate;
      keywordStats[k].totalSubs += d.subscribers;
    });
  });
  const keywordEffectiveness = Object.entries(keywordStats)
    .map(([keyword, s]) => ({
      keyword,
      channels: s.count,
      avgEngagement: parseFloat(((s.totalEng / s.count) * 100).toFixed(2)),
      avgSubs: Math.round(s.totalSubs / s.count),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement);

  // Activity distribution
  const now = Date.now();
  const activityBuckets = { active: 0, moderate: 0, inactive: 0, unknown: 0 };
  data.forEach((d) => {
    if (!d.last_video_date) {
      activityBuckets.unknown++;
      return;
    }
    const days = (now - new Date(d.last_video_date).getTime()) / 864e5;
    if (days < 14) activityBuckets.active++;
    else if (days < 60) activityBuckets.moderate++;
    else activityBuckets.inactive++;
  });

  res.json({
    success: true,
    analytics: {
      total: data.length,
      tierStats,
      countryDist,
      contactCoverage,
      topByEngagement,
      topBySubscribers,
      topByAvgViews,
      estimatedCosts: estimatedCosts.slice(0, 20),
      keywordEffectiveness,
      activityBuckets,
    },
  });
});

// SSE прогресс
app.get("/api/progress", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Отправляем текущий статус
  res.write(
    `event: status\ndata: ${JSON.stringify({ status: parserState.status })}\n\n`,
  );

  // Отправляем существующие логи
  for (const line of parserState.log) {
    res.write(`event: log\ndata: ${JSON.stringify({ message: line })}\n\n`);
  }

  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// ─── Запуск сервера ─────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n  YouTube Parser Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
  // Try to restore Telegram session if exists
  try {
    const ok = await tgOutreach.tryAutoLogin();
    if (ok) console.log("  [tg] Telegram session restored");
  } catch (e) {
    console.error("  [tg] auto-login error:", e.message);
  }
  // Start admin bot if configured
  try {
    adminBot.init();
  } catch (e) {
    console.error("  [admin-bot] init error:", e.message);
  }
  // Прогрев RAG-эмбеддера, не блокирующий старт сервера
  try {
    const kn = require("./services/knowledge");
    if (typeof kn.warmup === "function") {
      kn.warmup().catch((e) => console.warn("[knowledge warmup]", e.message));
    }
  } catch (e) {
    console.warn("[knowledge warmup] skipped:", e.message);
  }
});
