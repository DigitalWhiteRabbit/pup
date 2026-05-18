// services/knowledge.js — RAG база знаний (локальные эмбеддинги через @xenova/transformers)
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const { stmts } = require("../db/database");

// ─── SSRF Guard ───────────────────────────────────────────────────
// Проверяем что IP не относится к приватным/локальным диапазонам.
// Защищает от SSRF на 169.254.169.254 (AWS/GCP metadata), loopback, RFC1918 и т.д.
function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 10) return true; // 10/8
  if (a === 169 && b === 254) return true; // link-local incl. AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a >= 224) return true; // multicast / reserved
  return false;
}
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}
function isPrivateIP(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateIPv4(ip);
  if (fam === 6) return isPrivateIPv6(ip);
  return true; // неизвестный формат — считаем опасным
}

async function assertUrlIsSafe(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Некорректный URL: ${urlStr}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Разрешены только http/https, получено: ${u.protocol}`);
  }
  const host = u.hostname;
  // Если hostname уже IP — проверяем напрямую
  if (net.isIP(host)) {
    if (isPrivateIP(host))
      throw new Error(`Запрещённый IP (private/loopback/link-local): ${host}`);
    return u;
  }
  // Резолвим все адреса
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs || addrs.length === 0)
    throw new Error(`Не удалось разрешить hostname: ${host}`);
  for (const a of addrs) {
    if (isPrivateIP(a.address)) {
      throw new Error(
        `Hostname ${host} резолвится в приватный IP (${a.address}) — SSRF-риск`,
      );
    }
  }
  return u;
}

const MODEL_NAME =
  process.env.KNOWLEDGE_MODEL || "Xenova/multilingual-e5-small";
const CHUNK_SIZE = parseInt(process.env.KNOWLEDGE_CHUNK_SIZE || "800", 10);
const CHUNK_OVERLAP = parseInt(
  process.env.KNOWLEDGE_CHUNK_OVERLAP || "100",
  10,
);
const TOP_K = parseInt(process.env.KNOWLEDGE_TOP_K || "6", 10);
const EMBED_BATCH = 8;

// ─── Ленивая инициализация transformer pipeline ───────────────────
let _embedderPromise = null;
let _embedderReady = false;

async function getEmbedder() {
  if (_embedderPromise) return _embedderPromise;
  _embedderPromise = (async () => {
    // dynamic import для ESM-only @xenova/transformers
    const { pipeline, env } = await import("@xenova/transformers");
    // Разрешаем скачивание модели, кэш в node_modules/@xenova/transformers/.cache
    env.allowRemoteModels = true;
    const pipe = await pipeline("feature-extraction", MODEL_NAME, {
      quantized: true,
    });
    _embedderReady = true;
    console.log(`[knowledge] embedder ready: ${MODEL_NAME}`);
    return pipe;
  })().catch((e) => {
    _embedderPromise = null;
    throw e;
  });
  return _embedderPromise;
}

function isEmbedderReady() {
  return _embedderReady;
}

// Прогрев эмбеддера на старте: грузит модель + прогоняет dummy-инференс,
// чтобы первый реальный knowledge-запрос не ждал 5-30с инициализации onnx.
async function warmup() {
  try {
    const embedder = await getEmbedder();
    const t0 = Date.now();
    await embedder("query: warmup", { pooling: "mean", normalize: true });
    console.log(`[knowledge] warmup inference done in ${Date.now() - t0}ms`);
  } catch (e) {
    console.warn("[knowledge.warmup] embedder init failed:", e.message);
  }
}

// ─── Извлечение текста ────────────────────────────────────────────
async function extractText(buffer, mime, filename = "") {
  const lowerName = (filename || "").toLowerCase();
  const m = (mime || "").toLowerCase();

  if (m.includes("pdf") || lowerName.endsWith(".pdf")) {
    const pdfParse = require("pdf-parse");
    const out = await pdfParse(buffer);
    return String(out.text || "").trim();
  }
  if (m.includes("wordprocessingml") || lowerName.endsWith(".docx")) {
    const mammoth = require("mammoth");
    const out = await mammoth.extractRawText({ buffer });
    return String(out.value || "").trim();
  }
  // TXT / MD / default
  return buffer.toString("utf8").trim();
}

// Fetch HTML с SSRF-защитой и ручной обработкой редиректов.
// Возвращает { html, finalUrl, contentType } либо бросает.
async function fetchHtml(url, { maxRedirects = 5, timeoutMs = 20000 } = {}) {
  await assertUrlIsSafe(url);
  let currentUrl = url;
  let res;
  for (let i = 0; i <= maxRedirects; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      res = await fetch(currentUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; KnowledgeBot/1.0)" },
        redirect: "manual",
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, currentUrl).toString();
      await assertUrlIsSafe(next);
      currentUrl = next;
      if (i === maxRedirects) throw new Error("Слишком много редиректов");
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${currentUrl}`);
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  return { html: text, finalUrl: currentUrl, contentType };
}

// Извлечь title+text из готового HTML через readability, fallback — cheerio.
function extractTextFromHtml(html, url) {
  try {
    const { JSDOM } = require("jsdom");
    const { Readability } = require("@mozilla/readability");
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (
      article &&
      article.textContent &&
      article.textContent.trim().length > 200
    ) {
      return {
        title: article.title || url,
        text: article.textContent.trim(),
      };
    }
  } catch (e) {
    console.warn(
      "[knowledge] readability failed, fallback to cheerio:",
      e.message,
    );
  }
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  $("script,style,noscript,iframe,nav,footer,header").remove();
  const title = ($("title").first().text() || "").trim() || url;
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return { title, text };
}

async function fetchUrlText(url) {
  const { html, finalUrl, contentType } = await fetchHtml(url);
  if (contentType && !/html|xhtml|xml/i.test(contentType)) {
    throw new Error(`Unsupported content-type: ${contentType}`);
  }
  return extractTextFromHtml(html, finalUrl);
}

// ─── Чанкование ───────────────────────────────────────────────────
function chunkText(text, opts = {}) {
  const size = opts.size || CHUNK_SIZE;
  const overlap = opts.overlap || CHUNK_OVERLAP;
  const words = String(text || "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const slice = words.slice(i, i + size);
    chunks.push(slice.join(" "));
    if (i + size >= words.length) break;
    i += Math.max(1, size - overlap);
  }
  return chunks;
}

// ─── Эмбеддинги ───────────────────────────────────────────────────
async function embedBatch(texts, prefix = "passage: ") {
  const embedder = await getEmbedder();
  const inputs = texts.map((t) => prefix + String(t));
  const output = await embedder(inputs, { pooling: "mean", normalize: true });
  // output.data (Float32Array) shape [N, D]
  const D = output.dims[output.dims.length - 1];
  const result = [];
  for (let i = 0; i < texts.length; i++) {
    const arr = new Float32Array(D);
    arr.set(output.data.slice(i * D, (i + 1) * D));
    result.push(arr);
  }
  return result;
}

async function embed(texts, prefix = "passage: ") {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const embs = await embedBatch(batch, prefix);
    out.push(...embs);
  }
  return out;
}

function embeddingToBlob(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
function blobToEmbedding(buf) {
  // Важно: копируем, чтобы не зависеть от underlying буфера
  const arr = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < arr.length; i++) arr[i] = view.getFloat32(i * 4, true);
  return arr;
}

function cosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── Кэш чанков ───────────────────────────────────────────────────
const _cache = new Map(); // projectId(or 'all') -> { at, items:[{chunkText,title,source,kind,vec}] }
const CACHE_TTL_MS = 60 * 1000;

function invalidateCache() {
  _cache.clear();
}

function loadChunksForProject(projectId) {
  const key = projectId == null ? "all" : String(projectId);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;
  const rows = stmts.getAllChunksForProject.all({
    project_id: projectId == null ? null : projectId,
  });
  const items = rows.map((r) => ({
    chunk_text: r.chunk_text,
    title: r.doc_title,
    source: r.doc_source,
    kind: r.doc_kind,
    vec: blobToEmbedding(r.embedding),
  }));
  _cache.set(key, { at: Date.now(), items });
  return items;
}

// ─── Индексация документа ─────────────────────────────────────────
async function indexDocument(docId) {
  const doc = stmts.getKnowledgeDoc.get(docId);
  if (!doc) throw new Error(`doc ${docId} not found`);
  const now = new Date().toISOString();
  stmts.setKnowledgeDocStatus.run("indexing", null, now, docId);
  try {
    const text = String(doc.content || "").trim();
    if (!text) throw new Error("пустой контент");
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("нет чанков после разбиения");

    // удалить старые чанки
    stmts.deleteChunksByDoc.run(docId);

    // батчами эмбеддим и пишем
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const slice = chunks.slice(i, i + EMBED_BATCH);
      const embs = await embed(slice, "passage: ");
      const ts = new Date().toISOString();
      for (let j = 0; j < slice.length; j++) {
        stmts.insertKnowledgeChunk.run({
          doc_id: docId,
          position: i + j,
          chunk_text: slice[j],
          embedding: embeddingToBlob(embs[j]),
          token_count: slice[j].split(/\s+/).length,
          created_at: ts,
        });
      }
    }

    stmts.setKnowledgeDocChunks.run(
      chunks.length,
      "indexed",
      new Date().toISOString(),
      docId,
    );
    invalidateCache();
    return { chunks: chunks.length };
  } catch (e) {
    stmts.setKnowledgeDocStatus.run(
      "failed",
      String(e.message || e).slice(0, 500),
      new Date().toISOString(),
      docId,
    );
    invalidateCache();
    throw e;
  }
}

// ─── Поиск ────────────────────────────────────────────────────────
async function searchKnowledge(projectId, queryText, topK = TOP_K) {
  if (!queryText || !String(queryText).trim()) return [];
  const items = loadChunksForProject(projectId);
  if (items.length === 0) return [];
  const [qvec] = await embed([String(queryText).slice(0, 2000)], "query: ");
  const scored = items.map((it) => ({
    chunk_text: it.chunk_text,
    title: it.title,
    source: it.source,
    kind: it.kind,
    score: cosineSim(qvec, it.vec),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

module.exports = {
  MODEL_NAME,
  CHUNK_SIZE,
  TOP_K,
  extractText,
  fetchUrlText,
  fetchHtml,
  extractTextFromHtml,
  assertUrlIsSafe,
  chunkText,
  embed,
  embeddingToBlob,
  blobToEmbedding,
  cosineSim,
  indexDocument,
  searchKnowledge,
  invalidateCache,
  getEmbedder,
  isEmbedderReady,
  warmup,
};
