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
const { getDb } = require("./db/database");
const authRouter = require("./routes/auth");
const unsubscribeRouter = require("./routes/unsubscribe");
const { importFromCsv } = require("./db/lead-importer");
const tgOutreach = require("./services/telegram-outreach");
const adminBot = require("./services/admin-bot");
const apiKeysRouter = require("./routes/api-keys");
const apiKeysDb = require("./db/api-keys");

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

// Workspace isolation: extract workspaceId from query or header
app.use((req, res, next) => {
  req.workspaceId =
    req.query.workspace || req.headers["x-workspace-id"] || "default";
  next();
});

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
app.use("/api/api-keys", apiKeysRouter);

const ARCHIVE_DIR = path.join(__dirname, "Архив парсинг");
// Per-workspace CSV path
function getOutputCsv(workspaceId) {
  if (!workspaceId || workspaceId === "default")
    return path.join(ARCHIVE_DIR, "output.csv");
  const wsDir = path.join(__dirname, "data", "ws-" + workspaceId);
  if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true });
  return path.join(wsDir, "output.csv");
}
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

function getDeletedFile(workspaceId) {
  if (!workspaceId || workspaceId === "default") return DELETED_FILE;
  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, `deleted-${workspaceId}.json`);
}
function loadDeleted(workspaceId) {
  const file = getDeletedFile(workspaceId);
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}
function saveDeleted(workspaceId, ids) {
  fs.writeFileSync(
    getDeletedFile(workspaceId),
    JSON.stringify(ids, null, 2),
    "utf-8",
  );
}

// ─── Состояние парсера (per-workspace) ──────────────────────────────────────

const parserStates = new Map(); // workspaceId → state
const sseClientsByWs = new Map(); // workspaceId → res[]

function getParserState(wsId) {
  if (!parserStates.has(wsId)) {
    parserStates.set(wsId, {
      status: "idle",
      process: null,
      log: [],
      error: null,
    });
  }
  return parserStates.get(wsId);
}

function getSseClients(wsId) {
  if (!sseClientsByWs.has(wsId)) sseClientsByWs.set(wsId, []);
  return sseClientsByWs.get(wsId);
}

function broadcast(event, data, wsId) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const clients = getSseClients(wsId || "default");
  const alive = [];
  for (const res of clients) {
    try {
      res.write(msg);
      alive.push(res);
    } catch {}
  }
  sseClientsByWs.set(wsId || "default", alive);
}

// ─── Graceful error handling ────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

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
    const wsCsv = getOutputCsv(req.workspaceId);
    const data = fs.existsSync(wsCsv) ? parseCsv(wsCsv) : [];
    // Join с leads DB по channel_id
    try {
      const { db } = getDb(req.workspaceId);
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

// Квота (per-workspace, from API key pool)
app.get("/api/quota", (req, res) => {
  try {
    const quota = apiKeysDb.getWorkspaceQuota(req.workspaceId);

    // Always include the .env YOUTUBE_API_KEY in quota (it's used as fallback)
    const envKey = process.env.YOUTUBE_API_KEY;
    const hasEnvKey =
      envKey && envKey !== "your_key_here" && envKey.length > 10;
    // Check if env key is already in the pool (avoid double-counting)
    const poolKeys = apiKeysDb.getKeysForWorkspace(req.workspaceId);
    const envKeyInPool =
      hasEnvKey && poolKeys.some((k) => k.api_key === envKey);

    let envUsed = 0;
    if (hasEnvKey && !envKeyInPool && fs.existsSync(CACHE_FILE)) {
      try {
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
        envUsed = cache.apiUnitsUsed || 0;
      } catch {}
    }

    const envExtra = hasEnvKey && !envKeyInPool ? 1 : 0;
    const totalKeys = quota.keys + envExtra;
    const totalQuota = quota.totalQuota + (envExtra ? 10000 : 0);
    const totalUsed = quota.totalUsed + envUsed;

    const perKey = [...(quota.perKey || [])];
    if (envExtra) {
      perKey.unshift({
        id: 0,
        label: ".env (fallback)",
        key: envKey.slice(0, 8) + "...",
        quota: 10000,
        used: envUsed,
      });
    }

    res.json({
      success: true,
      used: totalUsed,
      total: totalQuota,
      remaining: Math.max(0, totalQuota - totalUsed),
      keys: totalKeys,
      perKey,
    });
  } catch {
    res.json({
      success: true,
      used: 0,
      total: 10000,
      remaining: 10000,
      keys: 0,
    });
  }
});

// Статус парсера
app.get("/api/status", (req, res) => {
  const ps = getParserState(req.workspaceId);
  res.json({
    success: true,
    status: ps.status,
    error: ps.error,
    logLength: ps.log.length,
  });
});

// Запустить парсер
app.post("/api/parse", adminAuth, (req, res) => {
  if (getParserState(req.workspaceId).status === "running") {
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
  args.push("--output", getOutputCsv(req.workspaceId));
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
  // Передаём удалённые каналы (per workspace)
  const deletedIds = loadDeleted(req.workspaceId);
  if (deletedIds.length > 0) args.push("--skip-channels", deletedIds.join(","));

  const ps = getParserState(req.workspaceId);
  ps.status = "running";
  ps.log = [];
  ps.error = null;
  ps.startedAt = new Date().toISOString();
  ps.workspaceId = req.workspaceId;
  ps.params = {
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

  broadcast("status", { status: "running" }, req.workspaceId);

  // Build API key pool for this workspace
  const poolKeys = apiKeysDb.getKeysForWorkspace(req.workspaceId);
  const childEnv = { ...process.env, PARSER_WORKSPACE_ID: req.workspaceId };
  if (poolKeys.length > 0) {
    // Pass pool keys as JSON — index.js will rotate through them
    childEnv.YT_API_KEY_POOL = JSON.stringify(
      poolKeys.map((k) => ({
        id: k.id,
        key: k.api_key,
        quota: k.daily_quota,
        used: k.used_today,
      })),
    );
  }

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "index.js"), ...args],
    {
      cwd: __dirname,
      env: childEnv,
    },
  );

  ps.process = child;
  const wsId = req.workspaceId;

  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      // Parse key usage reports from parser child
      const usageMatch = line.match(/^__KEY_USAGE__:(\d+):(\d+)$/);
      if (usageMatch) {
        try {
          apiKeysDb.addUsage(parseInt(usageMatch[1]), parseInt(usageMatch[2]));
        } catch {}
        continue; // don't show internal messages in log
      }
      ps.log.push(line);
      broadcast("log", { message: line }, wsId);
    }
  });

  child.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      ps.log.push(`[ERR] ${line}`);
      broadcast("log", { message: `[ERR] ${line}` }, wsId);
    }
  });

  child.on("close", (code) => {
    ps.process = null;
    const finishedAt = new Date().toISOString();
    if (code === 0) {
      ps.status = "done";
      broadcast("status", { status: "done" }, wsId);
    } else {
      ps.status = "error";
      ps.error = `Процесс завершился с кодом ${code}`;
      broadcast("status", { status: "error", error: ps.error }, wsId);
    }
    // Save to history
    const history = loadJson(HISTORY_FILE, []);
    const wsCsvPath = getOutputCsv(ps.workspaceId || "default");
    const resultCount = fs.existsSync(wsCsvPath)
      ? parseCsv(wsCsvPath).length
      : 0;
    history.unshift({
      id: Date.now(),
      startedAt: ps.startedAt,
      finishedAt,
      status: ps.status,
      error: ps.error,
      params: ps.params,
      resultCount,
    });
    if (history.length > 50) history.length = 50;
    saveJson(HISTORY_FILE, history);
  });

  child.on("error", (err) => {
    ps.process = null;
    ps.status = "error";
    ps.error = err.message;
    broadcast("status", { status: "error", error: err.message }, wsId);
  });

  res.json({ success: true, message: "Парсер запущен" });
});

// Остановить парсер
app.post("/api/stop", adminAuth, (req, res) => {
  const ps = getParserState(req.workspaceId);
  if (ps.status !== "running" || !ps.process) {
    return res.status(400).json({ success: false, error: "Парсер не запущен" });
  }

  ps.process.kill("SIGTERM");
  ps.status = "idle";
  ps.process = null;
  broadcast("status", { status: "idle" }, req.workspaceId);

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
    const wsCsvDel = getOutputCsv(req.workspaceId);
    if (fs.existsSync(wsCsvDel)) fs.unlinkSync(wsCsvDel);
    res.json({ success: true, message: "Данные очищены" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Удалённые каналы (per workspace)
app.get("/api/deleted", (req, res) => {
  res.json({ success: true, ids: loadDeleted(req.workspaceId) });
});

app.post("/api/deleted", adminAuth, (req, res) => {
  const { channelId } = req.body;
  if (!channelId)
    return res
      .status(400)
      .json({ success: false, error: "channelId required" });
  const ids = loadDeleted(req.workspaceId);
  if (!ids.includes(channelId)) {
    ids.push(channelId);
    saveDeleted(req.workspaceId, ids);
  }
  res.json({ success: true });
});

app.delete("/api/deleted/:channelId", adminAuth, (req, res) => {
  const ids = loadDeleted(req.workspaceId).filter(
    (id) => id !== req.params.channelId,
  );
  saveDeleted(req.workspaceId, ids);
  res.json({ success: true });
});

// Скачать CSV
app.get("/api/download", (req, res) => {
  const dlCsv = getOutputCsv(req.workspaceId);
  if (!fs.existsSync(dlCsv)) {
    return res.status(404).json({ success: false, error: "Файл не найден" });
  }
  res.download(dlCsv, "youtube_bloggers.csv");
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
  const anCsv = getOutputCsv(req.workspaceId);
  const data = fs.existsSync(anCsv) ? parseCsv(anCsv) : [];
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

// SSE прогресс (per-workspace)
app.get("/api/progress", (req, res) => {
  const wsId = req.workspaceId;
  const ps = getParserState(wsId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Отправляем текущий статус
  res.write(
    `event: status\ndata: ${JSON.stringify({ status: ps.status })}\n\n`,
  );

  // Отправляем существующие логи
  for (const line of ps.log) {
    res.write(`event: log\ndata: ${JSON.stringify({ message: line })}\n\n`);
  }

  getSseClients(wsId).push(res);

  req.on("close", () => {
    const clients = getSseClients(wsId);
    sseClientsByWs.set(
      wsId,
      clients.filter((c) => c !== res),
    );
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
  // Auto-start outreach worker (inbox polling, follow-ups, deal processing)
  try {
    const worker = require("./services/outreach-worker");
    if (process.env.RESEND_API_KEY && process.env.IMAP_HOST) {
      worker.start();
      console.log(
        "  [worker] Outreach worker started (inbox + follow-ups + deals)",
      );
    } else {
      console.log(
        "  [worker] Outreach worker skipped — RESEND_API_KEY or IMAP_HOST not set",
      );
    }
  } catch (e) {
    console.error("  [worker] start error:", e.message);
  }
});
