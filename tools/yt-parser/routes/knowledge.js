// routes/knowledge.js — API для базы знаний (RAG)
// Шаг 3.3b-6: переведён на db/prisma-store (единый Prisma-Postgres PUP).
// docId — cuid-строка; embedding в Prisma — JSON float-массив (сериализация в сервисе).
const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const { adminAuth } = require("../utils/auth");
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
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

// Активный проект воркспейса (cuid) или null (общие знания).
async function activeProjectId(req) {
  try {
    const p = await store.getActiveProject(req.wsId);
    return p ? p.id : null;
  } catch {
    return null;
  }
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// Фоновая индексация (не блокируем ответ). wsId — cuid воркспейса.
function indexInBackground(wsId, docId) {
  setImmediate(async () => {
    try {
      await kn.indexDocument(wsId, docId);
      console.log(`[knowledge] indexed doc ${docId}`);
    } catch (e) {
      console.error(`[knowledge] index fail doc ${docId}:`, e.message);
    }
  });
}

// GET /api/knowledge — список документов (без content)
router.get("/", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const pid = await activeProjectId(req);
    const docs = await store.listKnowledgeDocs(req.wsId, pid);
    res.json({ success: true, docs, project_id: pid });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/knowledge/status — статистика
router.get("/status", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const pid = await activeProjectId(req);
    const s = await store.knowledgeStats(req.wsId, pid);
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
router.get("/:id", async (req, res, next) => {
  // /status и /crawl/status зарегистрированы выше и матчатся раньше; сюда
  // долетают только реальные cuid-доки. Явно исключаем известные суб-пути.
  if (req.params.id === "status" || req.params.id === "crawl") return next();
  if (!requireWsId(req, res)) return;
  const doc = await store.getKnowledgeDoc(req.wsId, req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: "not found" });
  res.json({ success: true, doc });
});

// POST /api/knowledge/text — добавить текст
router.post("/text", express.json({ limit: "10mb" }), async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const { title, content } = req.body || {};
    if (!title || !content)
      return res
        .status(400)
        .json({ success: false, error: "title и content обязательны" });
    const now = new Date().toISOString();
    const pid = await activeProjectId(req);
    const info = await store.insertKnowledgeDoc(req.wsId, {
      project_id: pid,
      kind: "text",
      title: String(title).slice(0, 300),
      source: null,
      mime: "text/plain",
      size_bytes: Buffer.byteLength(content, "utf8"),
      content: String(content),
      checksum: sha256(content),
      created_at: now,
    });
    indexInBackground(req.wsId, info.id);
    res.json({ success: true, id: info.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/knowledge/url — добавить URL
router.post("/url", express.json(), async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const { url } = req.body || {};
    if (!url)
      return res.status(400).json({ success: false, error: "url обязателен" });
    const now = new Date().toISOString();
    const pid = await activeProjectId(req);
    const wsId = req.wsId;

    // Сначала вставим placeholder, потом попытаемся загрузить
    const info = await store.insertKnowledgeDoc(wsId, {
      project_id: pid,
      kind: "url",
      title: url.slice(0, 300),
      source: url,
      mime: "text/html",
      size_bytes: 0,
      content: "",
      checksum: null,
      created_at: now,
    });
    const docId = info.id;

    // Асинхронно fetch+index
    setImmediate(async () => {
      try {
        const { title, text } = await kn.fetchUrlText(url);
        await store.updateKnowledgeDocContent(wsId, docId, {
          title: (title || url).slice(0, 300),
          content: text,
          checksum: sha256(text),
          size_bytes: Buffer.byteLength(text, "utf8"),
          status: "pending",
          error: null,
        });
        await kn.indexDocument(wsId, docId);
      } catch (e) {
        console.error("[knowledge] url fetch/index fail:", e.message);
        await store.updateKnowledgeDocStatus(
          wsId,
          docId,
          "failed",
          String(e.message).slice(0, 500),
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
    if (!requireWsId(req, res)) return;
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
    const pid = await activeProjectId(req);
    const info = await store.insertKnowledgeDoc(req.wsId, {
      project_id: pid,
      kind: "file",
      title: String(title).slice(0, 300),
      source: originalname,
      mime: mimetype,
      size_bytes: size,
      content: text,
      checksum: sha256(text),
      created_at: now,
    });
    indexInBackground(req.wsId, info.id);
    res.json({
      success: true,
      id: info.id,
      extracted_chars: text.length,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/knowledge/:id/reindex
router.post("/:id/reindex", express.json(), async (req, res, next) => {
  if (req.params.id === "crawl") return next();
  if (!requireWsId(req, res)) return;
  const id = req.params.id; // cuid-строка
  const wsId = req.wsId;
  const doc = await store.getKnowledgeDoc(wsId, id);
  if (!doc) return res.status(404).json({ success: false, error: "not found" });

  // Для URL — refetch
  if (doc.kind === "url" && doc.source) {
    setImmediate(async () => {
      try {
        const { title, text } = await kn.fetchUrlText(doc.source);
        await store.updateKnowledgeDocContent(wsId, id, {
          title: (title || doc.source).slice(0, 300),
          content: text,
          checksum: sha256(text),
          size_bytes: Buffer.byteLength(text, "utf8"),
          status: "pending",
          error: null,
        });
        await kn.indexDocument(wsId, id);
      } catch (e) {
        await store.updateKnowledgeDocStatus(
          wsId,
          id,
          "failed",
          String(e.message).slice(0, 500),
        );
      }
    });
  } else {
    indexInBackground(wsId, id);
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
    if (!requireWsId(req, res)) return;
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
    const wsId = req.wsId;
    const pid = await activeProjectId(req);

    setImmediate(async () => {
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
            const info = await store.insertKnowledgeDoc(wsId, {
              project_id: pid,
              kind: "url",
              title: String(titlePref).slice(0, 300),
              source: p.url,
              mime: "text/html",
              size_bytes: Buffer.byteLength(p.content || "", "utf8"),
              content: String(p.content || ""),
              checksum: sha256(p.content || ""),
              created_at: now,
            });
            crawlJob.createdDocIds.push(info.id);
            crawlJob.processed++;
            indexInBackground(wsId, info.id);
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
router.delete("/:id", async (req, res) => {
  try {
    if (!requireWsId(req, res)) return;
    const id = req.params.id; // cuid-строка
    await store.deleteKnowledgeDoc(req.wsId, id); // каскад чанков (relation)
    kn.invalidateCache();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
