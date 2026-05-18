// services/crawler.js — обход сайта и сбор страниц для Knowledge Base.
// CommonJS. Использует SSRF-safe fetch из services/knowledge.js.
const {
  fetchHtml,
  extractTextFromHtml,
  assertUrlIsSafe,
} = require("./knowledge");

const DEFAULT_MAX = 30;
const HARD_CAP = 100;
const CONCURRENCY = 3;
const MIN_TEXT_LEN = 500;

// ─── URL helpers ──────────────────────────────────────────────────
function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    u.hash = "";
    // убираем trailing slash (кроме корня)
    let p = u.pathname.replace(/\/+$/, "") || "/";
    u.pathname = p;
    // lower-case host
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
}

function sameHost(a, b) {
  try {
    return (
      new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

function looksLikeAsset(url) {
  return /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|pdf|zip|rar|7z|tar|gz|mp4|mp3|avi|mov|wmv|webm|woff2?|ttf|eot|xml|rss|atom)(\?|$)/i.test(
    url,
  );
}

// ─── Минимальный парсер robots.txt ────────────────────────────────
function parseRobots(text) {
  const lines = String(text || "").split(/\r?\n/);
  const groups = []; // [{agents:[], disallow:[], allow:[]}]
  let cur = null;
  let collectingAgents = false;
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!collectingAgents || !cur) {
        cur = { agents: [], disallow: [], allow: [] };
        groups.push(cur);
        collectingAgents = true;
      }
      cur.agents.push(value.toLowerCase());
    } else if (field === "disallow") {
      if (cur) {
        cur.disallow.push(value);
        collectingAgents = false;
      }
    } else if (field === "allow") {
      if (cur) {
        cur.allow.push(value);
        collectingAgents = false;
      }
    } else {
      collectingAgents = false;
    }
  }
  // берем группу для '*'
  const starGroup = groups.find((g) => g.agents.includes("*")) || null;
  return starGroup;
}

function robotsAllows(starGroup, pathname) {
  if (!starGroup) return true;
  // Самое длинное правило побеждает (allow > disallow при равной длине)
  let best = { len: -1, allow: true };
  const match = (rule) => {
    if (rule === "") return false; // пустой disallow = разрешено всё
    // поддержка * и $
    const pat =
      "^" +
      rule
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\*/g, ".*")
        .replace(/\\\$$/, "$");
    try {
      return new RegExp(pat).test(pathname);
    } catch {
      return false;
    }
  };
  for (const r of starGroup.disallow) {
    if (r && match(r) && r.length > best.len)
      best = { len: r.length, allow: false };
  }
  for (const r of starGroup.allow) {
    if (r && match(r) && r.length >= best.len)
      best = { len: r.length, allow: true };
  }
  return best.allow;
}

async function loadRobots(origin) {
  try {
    const { html } = await fetchHtml(origin + "/robots.txt", {
      timeoutMs: 10000,
    });
    return parseRobots(html);
  } catch {
    return null;
  }
}

// ─── Sitemap ──────────────────────────────────────────────────────
async function tryFetchSitemapUrls(origin) {
  const candidates = [origin + "/sitemap.xml", origin + "/sitemap_index.xml"];
  const out = [];
  const seen = new Set();
  for (const sm of candidates) {
    try {
      const { html } = await fetchHtml(sm, { timeoutMs: 15000 });
      const locs = Array.from(
        html.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi),
      ).map((m) => m[1].trim());
      // Sitemap index? рекурсивно (один уровень)
      const nested = locs.filter((u) => /sitemap.*\.xml/i.test(u));
      const pages = locs.filter((u) => !nested.includes(u));
      for (const p of pages) {
        if (!seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
      for (const nu of nested.slice(0, 5)) {
        try {
          const r = await fetchHtml(nu, { timeoutMs: 15000 });
          const nl = Array.from(
            r.html.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi),
          ).map((m) => m[1].trim());
          for (const p of nl)
            if (!seen.has(p)) {
              seen.add(p);
              out.push(p);
            }
        } catch {}
      }
      if (out.length > 0) return out;
    } catch {
      /* try next */
    }
  }
  return out;
}

// ─── Главная функция обхода ────────────────────────────────────────
async function crawlSite(startUrl, options = {}) {
  const maxPages = Math.min(options.maxPages || DEFAULT_MAX, HARD_CAP);
  const sameOrigin = options.sameOrigin !== false;
  const respectRobots = options.respectRobots !== false;
  const includePaths = options.includePaths || null;
  const excludePaths = options.excludePaths || null;
  const onProgress =
    typeof options.onProgress === "function" ? options.onProgress : () => {};

  const startNorm = normalizeUrl(startUrl);
  if (!startNorm) throw new Error("Некорректный стартовый URL");
  await assertUrlIsSafe(startNorm);

  const originUrl = new URL(startNorm);
  const origin = originUrl.origin;

  const robots = respectRobots ? await loadRobots(origin) : null;

  const pathAllowed = (u) => {
    try {
      const pu = new URL(u);
      if (
        sameOrigin &&
        pu.hostname.toLowerCase() !== originUrl.hostname.toLowerCase()
      )
        return false;
      if (looksLikeAsset(u)) return false;
      if (includePaths && !includePaths.test(pu.pathname)) return false;
      if (excludePaths && excludePaths.test(pu.pathname)) return false;
      if (
        respectRobots &&
        robots &&
        !robotsAllows(robots, pu.pathname + pu.search)
      )
        return false;
      return true;
    } catch {
      return false;
    }
  };

  // 1) пробуем sitemap
  let seedUrls = [];
  try {
    const smUrls = await tryFetchSitemapUrls(origin);
    seedUrls = smUrls
      .map((u) => normalizeUrl(u))
      .filter(Boolean)
      .filter(pathAllowed);
  } catch {
    seedUrls = [];
  }

  const visited = new Set();
  const results = [];
  const failed = [];

  // Обработать один URL: fetch + extract, возвращает {url,title,content} или null
  async function processOne(u) {
    try {
      onProgress({
        stage: "fetching",
        url: u,
        processed: results.length,
        total: Math.max(queue.length + results.length, seedUrls.length),
      });
      const { html, finalUrl, contentType } = await fetchHtml(u, {
        timeoutMs: 20000,
      });
      if (contentType && !/html|xhtml|xml/i.test(contentType)) {
        return { skip: true, reason: "non-html", url: u };
      }
      const { title, text } = extractTextFromHtml(html, finalUrl);
      // собираем ссылки
      let links = [];
      try {
        const cheerio = require("cheerio");
        const $ = cheerio.load(html);
        $("a[href]").each((_, a) => {
          const href = $(a).attr("href");
          if (!href) return;
          const n = normalizeUrl(href, finalUrl);
          if (n) links.push(n);
        });
      } catch {}
      if (!text || text.length < MIN_TEXT_LEN) {
        return { skip: true, reason: "too-short", url: finalUrl, links };
      }
      return { url: finalUrl, title: title || finalUrl, content: text, links };
    } catch (e) {
      return { error: e.message || String(e), url: u };
    }
  }

  // Если sitemap дал много — используем его целиком (без BFS за рамки)
  const useSitemap = seedUrls.length >= 3;
  let queue;
  if (useSitemap) {
    queue = seedUrls.slice(0, maxPages);
    // гарантируем старт
    if (!queue.includes(startNorm)) queue.unshift(startNorm);
  } else {
    queue = [startNorm];
  }

  while (queue.length > 0 && results.length < maxPages) {
    // формируем батч
    const batch = [];
    while (
      queue.length > 0 &&
      batch.length < CONCURRENCY &&
      results.length + batch.length < maxPages
    ) {
      const next = queue.shift();
      const norm = normalizeUrl(next);
      if (!norm || visited.has(norm)) continue;
      if (!pathAllowed(norm)) continue;
      visited.add(norm);
      batch.push(norm);
    }
    if (batch.length === 0) break;

    const outs = await Promise.all(
      batch.map((u) =>
        processOne(u).catch((e) => ({ error: e.message, url: u })),
      ),
    );

    for (const out of outs) {
      if (!out) continue;
      if (out.error) {
        failed.push({ url: out.url, error: out.error });
        onProgress({
          stage: "error",
          url: out.url,
          error: out.error,
          processed: results.length,
        });
        continue;
      }
      // добавить найденные ссылки в очередь (только в BFS-режиме)
      if (!useSitemap && Array.isArray(out.links)) {
        for (const l of out.links) {
          if (results.length + queue.length >= maxPages * 3) break;
          if (!visited.has(l) && pathAllowed(l)) {
            queue.push(l);
          }
        }
      }
      if (out.skip) {
        onProgress({
          stage: "skip",
          url: out.url,
          reason: out.reason,
          processed: results.length,
        });
        continue;
      }
      results.push({ url: out.url, title: out.title, content: out.content });
      onProgress({
        stage: "page",
        url: out.url,
        title: out.title,
        processed: results.length,
        total: maxPages,
      });
      if (results.length >= maxPages) break;
    }
  }

  return { pages: results, failed, usedSitemap: useSitemap };
}

module.exports = {
  crawlSite,
  normalizeUrl,
  parseRobots,
  robotsAllows,
};
