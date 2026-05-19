// routes/knowledge.js — API для базы знаний (RAG)
const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const { adminAuth } = require("../utils/auth");
const { getDb } = require("../db/database");
const kn = require("../services/knowledge");
const crawler = require("../services/crawler");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Все мутации — через adminAuth (GET оставляем открытыми для чтения UI)
router.use((req, res, next) => {
  if (req.method === "GET") return next();
  return adminAuth(req, res, next);
});
router.use((req, res, next) => {
  const ws = getDb(req.workspaceId);
  req.stmts = ws.stmts;
  req.db = ws.db;
  next();
});

function activeProjectId() {
  try {
    const p = req.stmts.getActiveProject.get();
    return p ? p.id : null;
  } catch {
    return null;
  }
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// Фоновая индексация (не блокируем ответ)
function indexInBackground(docId) {
  setImmediate(async () => {
    try {
      await kn.indexDocument(docId);
      console.log(`[knowledge] indexed doc #${docId}`);
    } catch (e) {
      console.error(`[knowledge] index fail doc #${docId}:`, e.message);
    }
  });
}

// GET /api/knowledge — список документов (без content)
router.get("/", (req, res) => {
  try {
    const pid = activeProjectId();
    const docs = req.stmts.listKnowledgeDocs.all({ project_id: pid });
    res.json({ success: true, docs, project_id: pid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/knowledge/status — статистика
router.get("/status", (req, res) => {
  try {
    const pid = activeProjectId();
    const s = req.stmts.knowledgeStats.get({ project_id: pid });
    res.json({
      success: true,
      stats: {
        docs: s.docs || 0,
        indexed: s.indexed || 0,
        pending: s.pending || 0,
        indexing: s.indexing || 0,
        failed: s.failed || 0,
        chunks: s.chunks || 0,
      },
      model: kn.MODEL_NAME,
      ready: kn.isEmbedderReady(),
      project_id: pid,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/knowledge/:id — один документ с content
router.get("/:id", (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const doc = req.stmts.getKnowledgeDoc.get(req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, doc });
});

// POST /api/knowledge/text — добавить текст
router.post("/text", express.json({ limit: "10mb" }), (req, res) => {
  try {
    const { title, content } = req.body || {};
    if (!title || !content)
      return res
        .status(400)
        .json({ success: false, error: "title и content обязательны" });
    const now = new Date().toISOString();
    const pid = activeProjectId();
    const info = req.stmts.insertKnowledgeDoc.run({
      project_id: pid,
      kind: "text",
      title: String(title).slice(0, 300),
      source: null,
      mime: "text/plain",
      size_bytes: Buffer.byteLength(content, "utf8"),
      content: String(content),
      checksum: sha256(content),
      status: "pending",
      created_at: now,
      updated_at: now,
    });
    indexInBackground(info.lastInsertRowid);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/knowledge/url — добавить URL
router.post("/url", express.json(), async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url)
      return res.status(400).json({ success: false, error: "url обязателен" });
    const now = new Date().toISOString();
    const pid = activeProjectId();

    // Сначала вставим placeholder, потом попытаемся загрузить
    const info = req.stmts.insertKnowledgeDoc.run({
      project_id: pid,
      kind: "url",
      title: url.slice(0, 300),
      source: url,
      mime: "text/html",
      size_bytes: 0,
      content: "",
      checksum: null,
      status: "pending",
      created_at: now,
      updated_at: now,
    });
    const docId = info.lastInsertRowid;

    // Асинхронно fetch+index
    setImmediate(async () => {
      try {
        const { title, text } = await kn.fetchUrlText(url);
        req.stmts.updateKnowledgeDoc.run({
          id: docId,
          title: (title || url).slice(0, 300),
          content: text,
          checksum: sha256(text),
          size_bytes: Buffer.byteLength(text, "utf8"),
          chunks_count: null,
          status: "pending",
          error: null,
          updated_at: new Date().toISOString(),
        });
        await kn.indexDocument(docId);
      } catch (e) {
        console.error("[knowledge] url fetch/index fail:", e.message);
        req.stmts.setKnowledgeDocStatus.run(
          "failed",
          String(e.message).slice(0, 500),
          new Date().toISOString(),
          docId,
        );
      }
    });

    res.json({ success: true, id: docId });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/knowledge/upload — загрузка файла
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "file обязателен" });
    const { originalname, mimetype, buffer, size } = req.file;
    const title = (req.body && req.body.title) || originalname;

    let text = "";
    try {
      text = await kn.extractText(buffer, mimetype, originalname);
    } catch (e) {
      return res
        .status(400)
        .json({ success: false, error: `extract failed: ${e.message}` });
    }
    if (!text || text.length < 10) {
      return res
        .status(400)
        .json({ success: false, error: "не удалось извлечь текст из файла" });
    }

    const now = new Date().toISOString();
    const pid = activeProjectId();
    const info = req.stmts.insertKnowledgeDoc.run({
      project_id: pid,
      kind: "file",
      title: String(title).slice(0, 300),
      source: originalname,
      mime: mimetype,
      size_bytes: size,
      content: text,
      checksum: sha256(text),
      status: "pending",
      created_at: now,
      updated_at: now,
    });
    indexInBackground(info.lastInsertRowid);
    res.json({
      success: true,
      id: info.lastInsertRowid,
      extracted_chars: text.length,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/knowledge/:id/reindex
router.post("/:id/reindex", express.json(), async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const id = Number(req.params.id);
  const doc = req.stmts.getKnowledgeDoc.get(id);
  if (!doc) return res.status(404).json({ success: false, error: "not found" });

  // Для URL — refetch
  if (doc.kind === "url" && doc.source) {
    setImmediate(async () => {
      try {
        const { title, text } = await kn.fetchUrlText(doc.source);
        req.stmts.updateKnowledgeDoc.run({
          id,
          title: (title || doc.source).slice(0, 300),
          content: text,
          checksum: sha256(text),
          size_bytes: Buffer.byteLength(text, "utf8"),
          chunks_count: null,
          status: "pending",
          error: null,
          updated_at: new Date().toISOString(),
        });
        await kn.indexDocument(id);
      } catch (e) {
        req.stmts.setKnowledgeDocStatus.run(
          "failed",
          String(e.message).slice(0, 500),
          new Date().toISOString(),
          id,
        );
      }
    });
  } else {
    indexInBackground(id);
  }
  res.json({ success: true });
});

// ─── Crawl site ──────────────────────────────────────────────────
// In-memory состояние единственной crawl-задачи
let crawlJob = null;
let crawlJobSeq = 0;

function newCrawlJob(url, maxPages) {
  crawlJobSeq++;
  crawlJob = {
    id: crawlJobSeq,
    running: true,
    url,
    maxPages,
    total: 0,
    discovered: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    current: null,
    log: [],
    createdDocIds: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  return crawlJob;
}

function pushCrawlLog(entry) {
  if (!crawlJob) return;
  crawlJob.log.push({ t: new Date().toISOString(), ...entry });
  if (crawlJob.log.length > 200)
    crawlJob.log.splice(0, crawlJob.log.length - 200);
}

// POST /api/knowledge/crawl — запустить обход сайта
router.post("/crawl", express.json(), async (req, res) => {
  try {
    const { url, maxPages, sameOrigin, respectRobots } = req.body || {};
    if (!url)
      return res.status(400).json({ success: false, error: "url обязателен" });
    if (crawlJob && crawlJob.running) {
      return res.status(409).json({
        success: false,
        error: "Crawl уже выполняется",
        job_id: crawlJob.id,
      });
    }

    // Без UI-ограничений: дефолт 1000, жёсткий safeguard 5000 (чтобы не уехать в бесконечность)
    const mp = Math.min(
      Math.max(parseInt(maxPages || 1000, 10) || 1000, 1),
      5000,
    );
    const job = newCrawlJob(url, mp);

    setImmediate(async () => {
      const pid = activeProjectId();
      try {
        let hostname = "";
        try {
          hostname = new URL(url).hostname;
        } catch {}
        const onProgress = (ev) => {
          if (!crawlJob) return;
          crawlJob.current = ev.url || crawlJob.current;
          if (ev.stage === "page") {
            crawlJob.discovered++;
            pushCrawlLog({ stage: "page", url: ev.url, title: ev.title });
          } else if (ev.stage === "error") {
            crawlJob.failed++;
            pushCrawlLog({ stage: "error", url: ev.url, error: ev.error });
          } else if (ev.stage === "skip") {
            crawlJob.skipped++;
          } else if (ev.stage === "fetching") {
            pushCrawlLog({ stage: "fetching", url: ev.url });
          }
        };

        const { pages, failed, usedSitemap } = await crawler.crawlSite(url, {
          maxPages: mp,
          sameOrigin: sameOrigin !== false,
          respectRobots: respectRobots !== false,
          onProgress,
        });

        crawlJob.total = pages.length;
        pushCrawlLog({
          stage: "info",
          message: `sitemap=${usedSitemap}, pages=${pages.length}, failed=${failed.length}`,
        });

        // Создаём документы и ставим на индексацию
        for (const p of pages) {
          try {
            const now = new Date().toISOString();
            const titlePref = hostname
              ? `[${hostname}] ${p.title || p.url}`
              : p.title || p.url;
            const info = req.stmts.insertKnowledgeDoc.run({
              project_id: pid,
              kind: "url",
              title: String(titlePref).slice(0, 300),
              source: p.url,
              mime: "text/html",
              size_bytes: Buffer.byteLength(p.content || "", "utf8"),
              content: String(p.content || ""),
              checksum: sha256(p.content || ""),
              status: "pending",
              created_at: now,
              updated_at: now,
            });
            crawlJob.createdDocIds.push(info.lastInsertRowid);
            crawlJob.processed++;
            indexInBackground(info.lastInsertRowid);
          } catch (e) {
            crawlJob.failed++;
            pushCrawlLog({ stage: "db-error", url: p.url, error: e.message });
            console.error("[crawl] insert fail:", e.message);
          }
        }

        crawlJob.running = false;
        crawlJob.finishedAt = new Date().toISOString();
        pushCrawlLog({
          stage: "done",
          processed: crawlJob.processed,
          failed: crawlJob.failed,
        });
      } catch (e) {
        console.error("[crawl] fatal:", e);
        if (crawlJob) {
          crawlJob.running = false;
          crawlJob.error = e.message || String(e);
          crawlJob.finishedAt = new Date().toISOString();
          pushCrawlLog({ stage: "fatal", error: crawlJob.error });
        }
      }
    });

    res.json({ success: true, job_id: job.id, accepted: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/knowledge/crawl/status — статус текущей задачи
router.get("/crawl/status", (req, res) => {
  if (!crawlJob) return res.json({ success: true, job: null });
  res.json({ success: true, job: crawlJob });
});

// DELETE /api/knowledge/:id
router.delete("/:id", (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const id = Number(req.params.id);
    req.stmts.deleteChunksByDoc.run(id); // на случай если FK CASCADE не сработал
    req.stmts.deleteKnowledgeDoc.run(id);
    kn.invalidateCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
