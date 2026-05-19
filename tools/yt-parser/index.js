const { Command } = require("commander");
const { google } = require("googleapis");
const { createObjectCsvWriter } = require("csv-writer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Конфигурация ───────────────────────────────────────────────────────────

// API key проверяется в main() после парсинга аргументов, чтобы --help работал без ключа
let youtube;

const CACHE_FILE = path.join(__dirname, "cache.json");
const ERROR_LOG = path.join(__dirname, "errors.log");

// Стоимость API запросов в units
const API_COSTS = {
  "search.list": 100,
  "channels.list": 1,
  "playlistItems.list": 1,
};

let apiUnitsUsed = 0;
const DAILY_QUOTA = 10000;

// ─── Утилиты ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logError(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(ERROR_LOG, line, "utf-8");
}

function extractEmails(text) {
  if (!text) return [];
  const matches = text.match(/[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/g);
  return matches ? [...new Set(matches)] : [];
}

// ─── YT category mapping ────────────────────────────────────────────────────
const YT_CATEGORY_MAP = {
  1: "Film & Animation",
  2: "Autos & Vehicles",
  10: "Music",
  15: "Pets & Animals",
  17: "Sports",
  19: "Travel & Events",
  20: "Gaming",
  22: "People & Blogs",
  23: "Comedy",
  24: "Entertainment",
  25: "News & Politics",
  26: "Howto & Style",
  27: "Education",
  28: "Science & Technology",
  29: "Nonprofits & Activism",
};
function categoryName(id) {
  if (!id) return "";
  return YT_CATEGORY_MAP[String(id)] || `Category #${id}`;
}

// ─── ER normalization ───────────────────────────────────────────────────────
function normalizeER(rawER) {
  const cap = 1.5;
  const flags = [];
  const r = Number(rawER) || 0;
  if (r > 0.25) flags.push("high_shorts_bias");
  if (r > cap) flags.push("capped");
  return { normalized: Math.min(r, cap), flags };
}

// ─── Email trust classification ─────────────────────────────────────────────
// Personal domains — высокое доверие (личный email блогера).
// Business-агентские/сетевые — низкое доверие (обычно менеджер/спонсор).
// Всё остальное — средний.
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "tutanota.com",
  "icloud.com",
  "me.com",
  "mac.me",
  "mail.ru",
  "inbox.ru",
  "bk.ru",
  "list.ru",
  "yandex.ru",
  "ya.ru",
  "yandex.com",
  "web.de",
  "gmx.de",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "fastmail.com",
  "qq.com",
  "163.com",
  "126.com",
]);
const BUSINESS_EMAIL_BLACKLIST = [
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
  /^postmaster@/i,
  /^mailer-daemon@/i,
  /^support@/i,
  /^help@/i,
  /^info@/i,
  /^admin@/i,
  /^webmaster@/i,
  /^press@/i,
  /^pr@/i,
  /^legal@/i,
  /^abuse@/i,
  /@(?:mcn|network|agency|management|talent|partners?|media)\./i,
];

function classifyEmail(email) {
  if (!email) return "unknown";
  if (BUSINESS_EMAIL_BLACKLIST.some((rx) => rx.test(email))) return "business";
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return "personal";
  return "business";
}

// Извлекает контакты с сохранением источника.
// sources: [{ text, label }] — порядок = приоритет (первый в списке = самый надёжный).
// Возвращает по каждому каналу массив { value, source, trust? }.
function extractContactsWithSource(sources) {
  const out = {
    emails: [],
    telegram: [],
    instagram: [],
    twitter: [],
    tiktok: [],
    vk: [],
    discord: [],
    whatsapp: [],
    websites: [],
  };
  const seen = {
    emails: new Map(),
    telegram: new Map(),
    instagram: new Map(),
    twitter: new Map(),
    tiktok: new Map(),
    vk: new Map(),
    discord: new Map(),
    whatsapp: new Map(),
    websites: new Map(),
  };

  function addUnique(kind, value, source, extra = {}) {
    if (!value) return;
    const key = kind === "emails" ? value.toLowerCase() : value;
    if (seen[kind].has(key)) return;
    seen[kind].set(key, true);
    out[kind].push({ value, source, ...extra });
  }

  for (const { text, label } of sources) {
    const c = extractContacts(text || "");
    c.emails.forEach((v) =>
      addUnique("emails", v, label, { trust: classifyEmail(v) }),
    );
    c.telegram.forEach((v) => addUnique("telegram", v, label));
    c.instagram.forEach((v) => addUnique("instagram", v, label));
    c.twitter.forEach((v) => addUnique("twitter", v, label));
    c.tiktok.forEach((v) => addUnique("tiktok", v, label));
    c.vk.forEach((v) => addUnique("vk", v, label));
    c.discord.forEach((v) => addUnique("discord", v, label));
    c.whatsapp.forEach((v) => addUnique("whatsapp", v, label));
    c.websites.forEach((v) => addUnique("websites", v, label));
  }

  // Email: сортируем personal → unknown → business, сохраняя порядок внутри (по источнику).
  const trustOrder = { personal: 0, unknown: 1, business: 2 };
  out.emails.sort(
    (a, b) => (trustOrder[a.trust] ?? 1) - (trustOrder[b.trust] ?? 1),
  );
  return out;
}

function extractContacts(text) {
  const contacts = {
    emails: [],
    telegram: [],
    instagram: [],
    twitter: [],
    tiktok: [],
    vk: [],
    discord: [],
    whatsapp: [],
    websites: [],
  };
  if (!text) return contacts;

  // Email
  const emailRx = /[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/g;
  const em = text.match(emailRx);
  if (em) contacts.emails = [...new Set(em)];

  // Telegram: t.me/xxx, telegram.me/xxx
  const tgRx = /(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/([a-zA-Z0-9_]{3,})/gi;
  let m;
  while ((m = tgRx.exec(text)) !== null) contacts.telegram.push(m[1]);
  contacts.telegram = [...new Set(contacts.telegram)];

  // Instagram
  const igRx =
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?/gi;
  while ((m = igRx.exec(text)) !== null) {
    if (!["p", "reel", "stories", "explore", "accounts"].includes(m[1]))
      contacts.instagram.push(m[1]);
  }
  contacts.instagram = [...new Set(contacts.instagram)];

  // Twitter / X
  const twRx =
    /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{1,15})\/?/gi;
  while ((m = twRx.exec(text)) !== null) {
    if (
      !["home", "search", "explore", "settings", "i", "intent"].includes(m[1])
    )
      contacts.twitter.push(m[1]);
  }
  contacts.twitter = [...new Set(contacts.twitter)];

  // TikTok
  const ttRx =
    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9_.]{1,30})\/?/gi;
  while ((m = ttRx.exec(text)) !== null) contacts.tiktok.push(m[1]);
  contacts.tiktok = [...new Set(contacts.tiktok)];

  // VK
  const vkRx = /(?:https?:\/\/)?(?:www\.)?vk\.com\/([a-zA-Z0-9_.]{1,30})\/?/gi;
  while ((m = vkRx.exec(text)) !== null) {
    if (
      !["wall", "feed", "im", "video", "music", "groups", "apps"].includes(m[1])
    )
      contacts.vk.push(m[1]);
  }
  contacts.vk = [...new Set(contacts.vk)];

  // Discord
  const dcRx = /(?:https?:\/\/)?discord\.(?:gg|com\/invite)\/([a-zA-Z0-9]+)/gi;
  while ((m = dcRx.exec(text)) !== null) contacts.discord.push(m[1]);
  contacts.discord = [...new Set(contacts.discord)];

  // WhatsApp: wa.me/number, api.whatsapp.com
  const waRx =
    /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?([0-9]{7,15})/gi;
  while ((m = waRx.exec(text)) !== null) contacts.whatsapp.push(m[1]);
  contacts.whatsapp = [...new Set(contacts.whatsapp)];

  // Phone numbers (international format)
  const phoneRx =
    /(?<![\/\d])(\+[0-9]{1,3}[\s\-]?(?:\([0-9]{1,4}\)[\s\-]?)?[0-9][\s\-0-9]{6,12}[0-9])(?![\/\d])/g;
  while ((m = phoneRx.exec(text)) !== null) {
    const phone = m[1].replace(/[\s\-()]/g, "");
    if (phone.length >= 10 && !contacts.whatsapp.includes(phone))
      contacts.whatsapp.push(phone);
  }
  contacts.whatsapp = [...new Set(contacts.whatsapp)];

  // Websites (non-social URLs)
  const socialDomains =
    /youtube|youtu\.be|instagram|twitter|x\.com|tiktok|vk\.com|t\.me|telegram|discord|wa\.me|whatsapp|facebook|fb\.com|google|apple|play\.google/i;
  const urlRx = /https?:\/\/[a-zA-Z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+/g;
  const urls = text.match(urlRx);
  if (urls) {
    const unique = [...new Set(urls.map((u) => u.replace(/[.,;)'"]+$/, "")))];
    contacts.websites = unique.filter((u) => !socialDomains.test(u));
  }

  return contacts;
}

// ─── Retry-обёртка ──────────────────────────────────────────────────────────

async function withRetry(fn, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.response?.status || err?.code;
      const retryable = status === 429 || (status >= 500 && status < 600);

      if (retryable && attempt < maxRetries) {
        const delay = 2000 * attempt;
        console.log(
          `  ⚠ ${label}: ошибка ${status}, повтор через ${delay / 1000}с (попытка ${attempt}/${maxRetries})`,
        );
        logError(`${label}: status=${status}, attempt=${attempt}, retrying`);
        await sleep(delay);
        continue;
      }

      logError(
        `${label}: status=${status}, message=${err.message}, failed after ${attempt} attempts`,
      );
      throw err;
    }
  }
}

// ─── Кэширование ────────────────────────────────────────────────────────────

// TTL для кэша
const CHANNEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      if (!c.channels) c.channels = {};
      if (!c.searches) c.searches = {};
      return c;
    } catch {
      return { channels: {}, searches: {} };
    }
  }
  return { channels: {}, searches: {} };
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

function isCacheFresh(cachedAt, ttlMs) {
  if (!cachedAt) return false;
  return Date.now() - new Date(cachedAt).getTime() < ttlMs;
}

function makeSearchKey(query, opts) {
  return [
    query,
    opts.language || "ru",
    opts.order || "relevance",
    opts.categoryId || "",
    opts.regionCode || "",
    opts.publishedAfter || "",
  ].join("|");
}

// ─── YouTube API функции ────────────────────────────────────────────────────

// YouTube Video Categories (основные)
const VIDEO_CATEGORIES = {
  1: "Film & Animation",
  2: "Autos & Vehicles",
  10: "Music",
  15: "Pets & Animals",
  17: "Sports",
  19: "Travel & Events",
  20: "Gaming",
  22: "People & Blogs",
  23: "Comedy",
  24: "Entertainment",
  25: "News & Politics",
  26: "Howto & Style",
  27: "Education",
  28: "Science & Technology",
  29: "Nonprofits & Activism",
};

async function searchChannelsByQuery(
  query,
  maxResults = 50,
  searchOpts = {},
  cache = null,
) {
  // ОПТИМИЗАЦИЯ #4: проверяем search cache (TTL 24h)
  const cacheKey = makeSearchKey(query, searchOpts);
  if (cache && cache.searches && cache.searches[cacheKey]) {
    const entry = cache.searches[cacheKey];
    if (
      isCacheFresh(entry.cached_at, SEARCH_CACHE_TTL_MS) &&
      entry.ids.length >= maxResults
    ) {
      console.log(
        `    ⚡ Из search cache (${entry.ids.length} каналов, обновлён ${new Date(entry.cached_at).toLocaleString("ru")})`,
      );
      return entry.ids.slice(0, maxResults);
    }
  }

  const channelIds = new Set();
  let pageToken = undefined;

  while (channelIds.size < maxResults) {
    const params = {
      part: "snippet",
      q: query,
      type: "video",
      maxResults: Math.min(50, maxResults - channelIds.size),
      pageToken,
      relevanceLanguage: searchOpts.language || "ru",
    };
    if (searchOpts.order) params.order = searchOpts.order;
    if (searchOpts.categoryId) params.videoCategoryId = searchOpts.categoryId;
    if (searchOpts.publishedAfter)
      params.publishedAfter = searchOpts.publishedAfter;
    if (searchOpts.regionCode) params.regionCode = searchOpts.regionCode;
    if (searchOpts.videoDuration)
      params.videoDuration = searchOpts.videoDuration;

    const res = await withRetry(
      () => youtube.search.list(params),
      `search "${query}"`,
    );
    apiUnitsUsed += API_COSTS["search.list"];

    const items = res.data.items || [];
    for (const item of items) {
      channelIds.add(item.snippet.channelId);
    }

    pageToken = res.data.nextPageToken;
    if (!pageToken || items.length === 0) break;
    await sleep(150);
  }

  const ids = [...channelIds];

  // Сохраняем в search cache
  if (cache) {
    if (!cache.searches) cache.searches = {};
    cache.searches[cacheKey] = { ids, cached_at: new Date().toISOString() };
  }

  return ids;
}

async function getChannelDetails(channelIds) {
  const results = [];

  // API принимает до 50 id за раз
  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    const res = await withRetry(
      () =>
        youtube.channels.list({
          part: "snippet,statistics,brandingSettings,contentDetails",
          id: batch.join(","),
        }),
      `channels.list batch ${i / 50 + 1}`,
    );
    apiUnitsUsed += API_COSTS["channels.list"];
    results.push(...(res.data.items || []));
    await sleep(150);
  }

  return results;
}

async function getRecentVideos(uploadsPlaylistId, count = 10) {
  const res = await withRetry(
    () =>
      youtube.playlistItems.list({
        part: "snippet,contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: count,
      }),
    `playlistItems "${uploadsPlaylistId}"`,
  );
  apiUnitsUsed += API_COSTS["playlistItems.list"];

  return res.data.items || [];
}

async function getChannelPlaylists(channelId, maxResults = 5) {
  try {
    const res = await withRetry(
      () =>
        youtube.playlists.list({
          channelId,
          maxResults,
          part: "snippet,contentDetails",
        }),
      `playlists.list "${channelId}"`,
    );
    apiUnitsUsed += API_COSTS["channels.list"]; // 1 unit
    return (res.data.items || []).map((p) => ({
      id: p.id,
      title: (p.snippet?.title || "").slice(0, 200),
      itemCount: p.contentDetails?.itemCount || 0,
    }));
  } catch (e) {
    console.warn(`    [playlists] ${channelId}: ${e.message}`);
    return [];
  }
}

async function getVideoDetails(videoIds, parts = "statistics") {
  if (videoIds.length === 0) return [];

  const res = await withRetry(
    () =>
      youtube.videos.list({
        part: parts,
        id: videoIds.join(","),
      }),
    `videos.list (${videoIds.length} videos)`,
  );
  apiUnitsUsed += API_COSTS["channels.list"]; // videos.list = 1 unit

  return res.data.items || [];
}

// ─── Ранняя фильтрация (без video-вызовов) ─────────────────────────────────
// Применяет min_subs/max_subs/country по данным из channels.list,
// чтобы НЕ делать playlistItems + videos.list для каналов которые всё равно отсеются.
// Country работает в SOFT режиме: пустой country проходит (мы не знаем откуда канал).

function applyEarlyFilters(channelData, options) {
  const stats = channelData.statistics || {};
  const branding = channelData.brandingSettings || {};
  const snippet = channelData.snippet || {};

  const subs = parseInt(stats.subscriberCount || "0", 10);
  const country = (
    branding.channel?.country ||
    snippet.country ||
    ""
  ).toUpperCase();

  if (options.minSubs !== undefined && subs < options.minSubs) return false;
  if (options.maxSubs !== undefined && subs > options.maxSubs) return false;
  // Soft country: пустой country проходит, заполненный — должен совпадать
  if (options.country && country && country !== options.country.toUpperCase())
    return false;
  return true;
}

// Проверка наличия хотя бы одного контакта (для outreach use-case)
function hasAnyContact(channel) {
  const fields = [
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
  return fields.some((f) => channel[f] && String(channel[f]).trim());
}

// ─── Обработка канала ───────────────────────────────────────────────────────

async function processChannel(channelData, options = {}) {
  const stats = channelData.statistics;
  const snippet = channelData.snippet;
  const branding = channelData.brandingSettings || {};
  const contentDetails = channelData.contentDetails;

  const subscriberCount = parseInt(stats.subscriberCount || "0", 10);
  const totalViews = parseInt(stats.viewCount || "0", 10);
  const videoCount = parseInt(stats.videoCount || "0", 10);

  const uploadsPlaylistId = contentDetails?.relatedPlaylists?.uploads;

  let avgViews = 0;
  let lastVideoDate = "";
  let recentVideoItems = [];
  let videoDescriptions = [];

  if (uploadsPlaylistId) {
    // Тянем 30 последних видео (1 unit, playlistItems.list maxResults=50)
    recentVideoItems = await getRecentVideos(uploadsPlaylistId, 30);
    await sleep(150);

    if (recentVideoItems.length > 0) {
      lastVideoDate =
        recentVideoItems[0]?.contentDetails?.videoPublishedAt ||
        recentVideoItems[0]?.snippet?.publishedAt ||
        "";

      // ОПТИМИЗАЦИЯ #5: если канал «мёртвый» (не публиковался > activeDays),
      // пропускаем videos.list — экономия 1 unit на канал
      let skipVideos = false;
      if (options.activeDays !== undefined && lastVideoDate) {
        const lastDate = new Date(lastVideoDate);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - options.activeDays);
        if (lastDate < cutoff) skipVideos = true;
      }

      const videoIds = recentVideoItems
        .map((v) => v.contentDetails?.videoId || v.snippet?.resourceId?.videoId)
        .filter(Boolean);

      if (videoIds.length > 0 && !skipVideos) {
        // Один объединённый вызов videos.list — statistics + snippet за 1 unit
        const videoData = await getVideoDetails(videoIds, "statistics,snippet");

        // Avg views по последним 10 (для engagement_rate)
        const top10ForViews = videoData.slice(0, 10);
        const totalRecentViews = top10ForViews.reduce(
          (sum, v) => sum + parseInt(v.statistics?.viewCount || "0", 10),
          0,
        );
        avgViews =
          top10ForViews.length > 0
            ? Math.round(totalRecentViews / top10ForViews.length)
            : 0;

        // Описания ВСЕХ 30 видео для поиска контактов
        videoDescriptions = videoData
          .map((v) => v.snippet?.description || "")
          .filter(Boolean);

        // Топ-5 последних видео для сводки (title + укороченный description)
        var lastVideosForSummary = videoData.slice(0, 5).map((v) => ({
          title: (v.snippet?.title || "").slice(0, 200),
          description: (v.snippet?.description || "").slice(0, 400),
          views: parseInt(v.statistics?.viewCount || "0", 10),
          publishedAt: v.snippet?.publishedAt || null,
          tags: Array.isArray(v.snippet?.tags)
            ? v.snippet.tags.slice(0, 15)
            : [],
          categoryId: v.snippet?.categoryId || null,
        }));
        // Главная категория = mode по categoryId последних роликов
        var firstVideoCategoryId = videoData[0]?.snippet?.categoryId || null;

        await sleep(150);
      }
    }
  }
  if (typeof lastVideosForSummary === "undefined")
    var lastVideosForSummary = [];
  if (typeof firstVideoCategoryId === "undefined")
    var firstVideoCategoryId = null;

  const engagementRate = subscriberCount > 0 ? avgViews / subscriberCount : 0;
  const erNorm = normalizeER(engagementRate);

  // Channel age (days)
  const channelPublishedAt = snippet.publishedAt || null;
  const channelAgeDays = channelPublishedAt
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(channelPublishedAt).getTime()) /
            (24 * 3600 * 1000),
        ),
      )
    : null;
  const channelLanguage =
    snippet.defaultLanguage || branding.channel?.defaultLanguage || "";
  const channelTags = branding.channel?.keywords || "";

  // Top playlists (best-effort, +1 unit)
  let topPlaylists = [];
  if (options.fetchPlaylists !== false) {
    try {
      topPlaylists = await getChannelPlaylists(channelData.id, 5);
      await sleep(100);
    } catch {
      /* ignore */
    }
  }

  // Сбор контактов с сохранением источника (priority: about → keywords → видео).
  const prioritizedSources = [
    { text: snippet.description || "", label: "channel_about" },
    { text: snippet.customUrl || "", label: "channel_about" },
    { text: branding.channel?.keywords || "", label: "channel_keywords" },
    ...videoDescriptions.map((d, i) => ({ text: d, label: `video:${i}` })),
  ];
  const contactsDetailed = extractContactsWithSource(prioritizedSources);
  // Для обратной совместимости: уплощённые поля + отдельный массив raw.
  const contacts = {
    emails: contactsDetailed.emails.map((x) => x.value),
    telegram: contactsDetailed.telegram.map((x) => x.value),
    instagram: contactsDetailed.instagram.map((x) => x.value),
    twitter: contactsDetailed.twitter.map((x) => x.value),
    tiktok: contactsDetailed.tiktok.map((x) => x.value),
    vk: contactsDetailed.vk.map((x) => x.value),
    discord: contactsDetailed.discord.map((x) => x.value),
    whatsapp: contactsDetailed.whatsapp.map((x) => x.value),
    websites: contactsDetailed.websites.map((x) => x.value),
  };
  const email = contacts.emails.join(";");

  const country = branding.channel?.country || snippet.country || "";
  const customUrl = snippet.customUrl || "";
  const channelUrl = customUrl
    ? `https://www.youtube.com/${customUrl}`
    : `https://www.youtube.com/channel/${channelData.id}`;

  // Используем medium (240x240) — более стабильный чем default (88x88)
  const thumbnail =
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.default?.url ||
    "";

  return {
    channel_id: channelData.id,
    channel_name: snippet.title,
    channel_url: channelUrl,
    subscribers: subscriberCount,
    total_views: totalViews,
    video_count: videoCount,
    avg_views_per_video: avgViews,
    engagement_rate: parseFloat(engagementRate.toFixed(4)),
    engagement_rate_raw: parseFloat(engagementRate.toFixed(4)),
    engagement_rate_normalized: parseFloat(erNorm.normalized.toFixed(4)),
    er_flags: erNorm.flags,
    country,
    email,
    telegram: contacts.telegram.join(";"),
    instagram: contacts.instagram.join(";"),
    twitter: contacts.twitter.join(";"),
    tiktok: contacts.tiktok.join(";"),
    vk: contacts.vk.join(";"),
    discord: contacts.discord.join(";"),
    whatsapp: contacts.whatsapp.join(";"),
    website: contacts.websites.join(";"),
    contacts_detailed: contactsDetailed,
    last_videos_json: JSON.stringify(lastVideosForSummary || []),
    channel_about_text: (snippet.description || "").slice(0, 2000),
    channel_tags: channelTags,
    top_playlists_json: JSON.stringify(topPlaylists),
    channel_published_at: channelPublishedAt,
    channel_age_days: channelAgeDays,
    channel_language: channelLanguage,
    main_category: categoryName(firstVideoCategoryId),
    main_category_id: firstVideoCategoryId,
    category: branding.channel?.keywords || "",
    description_snippet: (snippet.description || "").slice(0, 200),
    last_video_date: lastVideoDate ? lastVideoDate.split("T")[0] : "",
    thumbnail,
    keyword: "",
  };
}

// ─── Фильтрация ─────────────────────────────────────────────────────────────

function applyFilters(channel, options) {
  if (options.minSubs !== undefined && channel.subscribers < options.minSubs) {
    return false;
  }
  if (options.maxSubs !== undefined && channel.subscribers > options.maxSubs) {
    return false;
  }
  if (
    options.minEngagement !== undefined &&
    channel.engagement_rate < options.minEngagement
  ) {
    return false;
  }
  if (
    options.country &&
    channel.country.toUpperCase() !== options.country.toUpperCase()
  ) {
    return false;
  }
  if (options.activeDays !== undefined && channel.last_video_date) {
    const lastDate = new Date(channel.last_video_date);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - options.activeDays);
    if (lastDate < cutoff) return false;
  }
  return true;
}

// ─── CSV экспорт ─────────────────────────────────────────────────────────────

async function exportToCsv(channels, outputFile, append) {
  // При --append проверяем существующие channel_id из самой колонки channel_id
  let existingIds = new Set();
  if (append && fs.existsSync(outputFile)) {
    try {
      const { parseCsv } = require("./utils/csv");
      const existingRows = parseCsv(outputFile);
      for (const row of existingRows) {
        if (row.channel_id) existingIds.add(row.channel_id);
      }
    } catch (e) {
      console.error(
        "Не удалось прочитать существующий CSV для дедупа:",
        e.message,
      );
    }
  }

  const header = [
    { id: "channel_id", title: "channel_id" },
    { id: "channel_name", title: "channel_name" },
    { id: "channel_url", title: "channel_url" },
    { id: "subscribers", title: "subscribers" },
    { id: "total_views", title: "total_views" },
    { id: "video_count", title: "video_count" },
    { id: "avg_views_per_video", title: "avg_views_per_video" },
    { id: "engagement_rate", title: "engagement_rate" },
    { id: "country", title: "country" },
    { id: "email", title: "email" },
    { id: "telegram", title: "telegram" },
    { id: "instagram", title: "instagram" },
    { id: "twitter", title: "twitter" },
    { id: "tiktok", title: "tiktok" },
    { id: "vk", title: "vk" },
    { id: "discord", title: "discord" },
    { id: "whatsapp", title: "whatsapp" },
    { id: "website", title: "website" },
    { id: "category", title: "category" },
    { id: "description_snippet", title: "description_snippet" },
    { id: "last_video_date", title: "last_video_date" },
    { id: "thumbnail", title: "thumbnail" },
    { id: "keyword", title: "keyword" },
  ];

  if (append && fs.existsSync(outputFile)) {
    // Дедупликация: оставляем только новые каналы
    const newChannels = channels.filter(
      (ch) => !existingIds.has(ch.channel_id),
    );
    if (newChannels.length === 0) {
      console.log("Нет новых каналов для добавления.");
      return;
    }

    const csvWriter = createObjectCsvWriter({
      path: outputFile,
      header,
      append: true,
    });
    await csvWriter.writeRecords(newChannels);
    console.log(
      `Добавлено ${newChannels.length} новых каналов в ${outputFile}`,
    );
  } else {
    const csvWriter = createObjectCsvWriter({
      path: outputFile,
      header,
    });
    await csvWriter.writeRecords(channels);
  }
}

// ─── Главная функция ────────────────────────────────────────────────────────

async function main() {
  const program = new Command();

  program
    .name("yt-parser")
    .description("Парсер блогеров YouTube")
    .version("1.0.0")
    .option("--keywords <keywords>", "Ключевые слова через запятую")
    .option("--hashtags <hashtags>", "Хэштеги через запятую")
    .option("--min-subs <number>", "Минимум подписчиков")
    .option("--max-subs <number>", "Максимум подписчиков")
    .option("--min-engagement <number>", "Минимальный engagement rate")
    .option("--country <code>", "Код страны (например RU)")
    .option("--active-days <number>", "Максимум дней с последнего видео")
    .option("--limit <number>", "Максимум каналов в CSV", "100")
    .option("-o, --output <file>", "Имя выходного файла", "output.csv")
    .option("--append", "Добавить к существующему CSV без дублей")
    .option("--no-cache", "Не использовать кэш")
    .option(
      "--skip-channels <ids>",
      "Пропустить каналы (channel_id через запятую)",
    )
    .option(
      "--category <id>",
      "ID категории YouTube (например 28 = Science & Technology)",
    )
    .option(
      "--sort-by <order>",
      "Сортировка поиска: relevance, date, viewCount, rating",
      "relevance",
    )
    .option("--language <code>", "Язык поиска (например ru, en)", "ru")
    .option("--region <code>", "Код региона (например RU, US)")
    .option(
      "--published-after <date>",
      "Видео опубликованные после даты (YYYY-MM-DD)",
    )
    .option(
      "--video-duration <type>",
      "Тип контента: short (до 4 мин), medium (4-20 мин), long (20+ мин)",
    )
    .option(
      "--no-require-contacts",
      "Не требовать наличия контактов (по умолчанию: только с контактами)",
    )
    .option(
      "--max-search-pages <number>",
      "Максимум страниц поиска на источник (1 страница = 50 видео = 100 units)",
      "10",
    );

  program.parse(process.argv);
  const raw = program.opts();

  // Приводим типы вручную (commander передаёт previousValue в parseInt как radix)
  const opts = {
    keywords: raw.keywords,
    hashtags: raw.hashtags,
    minSubs: raw.minSubs ? parseInt(raw.minSubs, 10) : undefined,
    maxSubs: raw.maxSubs ? parseInt(raw.maxSubs, 10) : undefined,
    minEngagement: raw.minEngagement
      ? parseFloat(raw.minEngagement)
      : undefined,
    country: raw.country,
    activeDays: raw.activeDays ? parseInt(raw.activeDays, 10) : undefined,
    limit: parseInt(raw.limit, 10) || 100,
    output: raw.output,
    append: raw.append,
    cache: raw.cache,
    skipChannels: raw.skipChannels || "",
    category: raw.category,
    sortBy: raw.sortBy || "relevance",
    language: raw.language || "ru",
    region: raw.region,
    publishedAfter: raw.publishedAfter
      ? new Date(raw.publishedAfter).toISOString()
      : undefined,
    requireContacts: raw.requireContacts !== false,
    videoDuration: raw.videoDuration,
    maxSearchPages: parseInt(raw.maxSearchPages, 10) || 10,
  };

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY || API_KEY === "your_key_here") {
    console.error("Ошибка: укажите YOUTUBE_API_KEY в файле .env");
    process.exit(1);
  }
  youtube = google.youtube({ version: "v3", auth: API_KEY });

  if (!opts.keywords && !opts.hashtags) {
    console.error("Ошибка: укажите --keywords и/или --hashtags");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════");
  console.log("  YouTube Blogger Parser v1.0.0");
  console.log("═══════════════════════════════════════════");

  // Загружаем кэш
  let cache =
    opts.cache !== false ? loadCache() : { channels: {}, searches: {} };

  // ОПТИМИЗАЦИЯ #3: Cache TTL — считаем актуальными только каналы свежее 7 дней
  const cachedChannelIds = new Set(
    Object.entries(cache.channels)
      .filter(([_, ch]) => isCacheFresh(ch.cached_at, CHANNEL_CACHE_TTL_MS))
      .map(([id]) => id),
  );
  const staleCount = Object.keys(cache.channels).length - cachedChannelIds.size;
  if (staleCount > 0) {
    console.log(
      `  ℹ Кэш: ${cachedChannelIds.size} актуальных, ${staleCount} устаревших (старше 7 дней — будут переcпрошены)`,
    );
  }

  // ── Инкрементальный поиск + обработка ─────────────────────────────────
  // Алгоритм: для каждого источника (keyword/hashtag) пагинируем search.list,
  // обрабатываем каждую страницу, фильтруем — и останавливаемся как только
  // набрано `opts.limit` каналов прошедших ВСЕ фильтры (включая контакты).

  const searchOpts = {
    order: opts.sortBy,
    language: opts.language,
    categoryId: opts.category,
    regionCode: opts.region,
    publishedAfter: opts.publishedAfter,
    videoDuration: opts.videoDuration,
  };

  console.log("\n📡 Поиск и обработка каналов...");
  if (opts.category)
    console.log(
      `  Категория: ${VIDEO_CATEGORIES[opts.category] || opts.category}`,
    );
  if (opts.sortBy !== "relevance") console.log(`  Сортировка: ${opts.sortBy}`);
  if (opts.region) console.log(`  Регион: ${opts.region}`);
  if (opts.country)
    console.log(`  Страна (soft): ${opts.country} (пустые country проходят)`);
  if (opts.requireContacts) console.log(`  Только с контактами: да`);
  console.log(`  Цель: ${opts.limit} каналов после всех фильтров`);
  console.log(`  Бюджет поиска: ${opts.maxSearchPages} страниц на источник\n`);

  // Собираем источники
  const sources = [];
  if (opts.keywords) {
    opts.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
      .forEach((k) => {
        sources.push({ type: "keyword", query: k });
      });
  }
  if (opts.hashtags) {
    opts.hashtags
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)
      .forEach((h) => {
        sources.push({
          type: "hashtag",
          query: h.startsWith("#") ? h : "#" + h,
        });
      });
  }

  const skipSet = new Set(
    (opts.skipChannels || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const channelKeywords = {};
  const allProcessedIds = new Set();
  const filtered = []; // финальный список каналов прошедших все фильтры

  function trackChannelKeyword(channelId, kw) {
    if (!channelKeywords[channelId]) channelKeywords[channelId] = new Set();
    channelKeywords[channelId].add(kw);
  }

  // Хелпер: обрабатывает массив channelIds (применяет early filter, processChannel, late filter)
  // Возвращает количество новых добавленных в `filtered`
  async function processChannelBatch(channelIds, sourceQuery) {
    let added = 0;
    // Только новые ID, не из skip-списка
    const newIds = channelIds.filter(
      (id) => !allProcessedIds.has(id) && !skipSet.has(id),
    );
    if (newIds.length === 0) return 0;

    // Tag with source keyword
    for (const id of newIds) trackChannelKeyword(id, sourceQuery);

    // Разделяем: что в свежем кэше vs что нужно фетчить
    const fromCache = [];
    const toFetch = [];
    for (const id of newIds) {
      const cached = cache.channels[id];
      if (cached && isCacheFresh(cached.cached_at, CHANNEL_CACHE_TTL_MS)) {
        fromCache.push(cached);
      } else {
        toFetch.push(id);
      }
    }

    // Обработаем каналы из cache (без API)
    for (const ch of fromCache) {
      if (filtered.length >= opts.limit) return added;
      allProcessedIds.add(ch.channel_id);
      const merged = { ...ch };
      const kws = channelKeywords[ch.channel_id];
      if (kws) {
        const existing = merged.keyword ? merged.keyword.split(";") : [];
        merged.keyword = [...new Set([...existing, ...kws])].join(";");
      }
      if (!applyFilters(merged, opts)) continue;
      if (opts.requireContacts && !hasAnyContact(merged)) continue;
      filtered.push(merged);
      added++;
      console.log(
        `    ✓ [${filtered.length}/${opts.limit}] ${merged.channel_name} (cache)`,
      );
    }

    if (filtered.length >= opts.limit || toFetch.length === 0) return added;

    // Свежие каналы — channels.list batch
    const details = await getChannelDetails(toFetch);

    // Early filter (subs, country soft)
    let earlyRejected = 0;
    const earlyPassed = details.filter((d) => {
      if (applyEarlyFilters(d, opts)) return true;
      allProcessedIds.add(d.id);
      earlyRejected++;
      return false;
    });
    if (earlyRejected > 0) {
      console.log(
        `    ⚡ Early filter: -${earlyRejected} (экономия ~${earlyRejected * 2}u)`,
      );
    }

    // Обработка каждого: processChannel + late filter + contacts check
    for (const detail of earlyPassed) {
      if (filtered.length >= opts.limit) return added;
      allProcessedIds.add(detail.id);
      try {
        const processed = await processChannel(detail, opts);
        const kws = channelKeywords[processed.channel_id];
        if (kws) processed.keyword = [...kws].join(";");
        processed.cached_at = new Date().toISOString();
        cache.channels[processed.channel_id] = processed;
        cache.apiUnitsUsed = apiUnitsUsed;
        if (opts.cache !== false) saveCache(cache);

        if (!applyFilters(processed, opts)) {
          console.log(
            `    ✗ filter: ${processed.channel_name} (subs=${processed.subscribers}, eng=${(processed.engagement_rate * 100).toFixed(1)}%)`,
          );
          continue;
        }
        if (opts.requireContacts && !hasAnyContact(processed)) {
          console.log(`    ✗ no contacts: ${processed.channel_name}`);
          continue;
        }

        filtered.push(processed);
        added++;
        console.log(
          `    ✓ [${filtered.length}/${opts.limit}] ${processed.channel_name}`,
        );
      } catch (err) {
        console.error(`    ✗ ${detail.id}: ${err.message}`);
        logError(`processChannel ${detail.id}: ${err.message}`);
      }
    }
    return added;
  }

  // Главный цикл по источникам
  for (const source of sources) {
    if (filtered.length >= opts.limit) break;
    console.log(`\n  → ${source.type}: "${source.query}"`);

    // Проверка search cache
    const cacheKey = makeSearchKey(source.query, searchOpts);
    const cachedSearch = cache.searches?.[cacheKey];
    let usedCache = false;

    if (
      cachedSearch &&
      isCacheFresh(cachedSearch.cached_at, SEARCH_CACHE_TTL_MS)
    ) {
      console.log(
        `    ⚡ Search cache: ${cachedSearch.ids.length} каналов (${new Date(cachedSearch.cached_at).toLocaleString("ru")})`,
      );
      usedCache = true;
      // Обрабатываем кэшированные ids порциями по 50
      for (
        let i = 0;
        i < cachedSearch.ids.length && filtered.length < opts.limit;
        i += 50
      ) {
        const batch = cachedSearch.ids.slice(i, i + 50);
        await processChannelBatch(batch, source.query);
      }
    }

    // Если cache не использовался ИЛИ его не хватило — делаем live-поиск
    if (!usedCache || filtered.length < opts.limit) {
      let pageToken = undefined;
      let pageNum = 0;
      const collectedIds = usedCache ? [...cachedSearch.ids] : [];

      while (pageNum < opts.maxSearchPages && filtered.length < opts.limit) {
        pageNum++;
        const params = {
          part: "snippet",
          q: source.query,
          type: "video",
          maxResults: 50,
          pageToken,
          relevanceLanguage: opts.language || "ru",
        };
        if (opts.sortBy && opts.sortBy !== "relevance")
          params.order = opts.sortBy;
        if (opts.category) params.videoCategoryId = opts.category;
        if (opts.region) params.regionCode = opts.region;
        if (opts.publishedAfter) params.publishedAfter = opts.publishedAfter;

        let res;
        try {
          res = await withRetry(
            () => youtube.search.list(params),
            `search "${source.query}" p${pageNum}`,
          );
        } catch (e) {
          console.error(`    ✗ search page ${pageNum}: ${e.message}`);
          logError(`search "${source.query}" p${pageNum}: ${e.message}`);
          break;
        }
        apiUnitsUsed += API_COSTS["search.list"];

        const items = res.data.items || [];
        if (items.length === 0) break;

        const pageIds = [...new Set(items.map((i) => i.snippet.channelId))];
        collectedIds.push(...pageIds);
        console.log(`    Стр.${pageNum}: ${pageIds.length} каналов`);

        await processChannelBatch(pageIds, source.query);

        pageToken = res.data.nextPageToken;
        if (!pageToken) break;
        await sleep(150);
      }

      // Сохраняем в search cache
      if (collectedIds.length > 0) {
        if (!cache.searches) cache.searches = {};
        cache.searches[cacheKey] = {
          ids: [...new Set(collectedIds)],
          cached_at: new Date().toISOString(),
        };
        if (opts.cache !== false) saveCache(cache);
      }
    }
  }

  const limited = filtered;

  // ── Шаг 5: Экспорт в CSV ──────────────────────────────────────────────

  const outputFile = path.resolve(opts.output);
  await exportToCsv(limited, outputFile, opts.append);

  // ── Сводка ─────────────────────────────────────────────────────────────

  const estimatedRemaining = Math.max(0, DAILY_QUOTA - apiUnitsUsed);

  console.log("\n═══════════════════════════════════════════");
  console.log("  📋 СВОДКА");
  console.log("═══════════════════════════════════════════");
  console.log(`  Источников:                  ${sources.length}`);
  console.log(`  Каналов проверено:           ${allProcessedIds.size}`);
  console.log(
    `  Прошли все фильтры:          ${filtered.length} / ${opts.limit}`,
  );
  if (opts.requireContacts) console.log(`  (фильтр: только с контактами)`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Потрачено API units:         ${apiUnitsUsed}`);
  console.log(
    `  Остаток квоты (≈):           ${estimatedRemaining} / ${DAILY_QUOTA}`,
  );
  console.log(`  ─────────────────────────────`);
  console.log(`  Файл сохранён: ${outputFile}`);
  console.log("═══════════════════════════════════════════\n");
}

// ─── Запуск ──────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("Критическая ошибка:", err.message);
  logError(`CRITICAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});
