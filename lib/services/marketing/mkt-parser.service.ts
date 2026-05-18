"use server";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from "@/lib/db";

// NOTE: googleapis package must be installed: pnpm add googleapis
// It was in the standalone parser's package.json but not yet in PUP's.
// import { google } from "googleapis";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface ParseOptions {
  workspaceId: string;
  keywords?: string;
  hashtags?: string;
  minSubs?: number;
  maxSubs?: number;
  minEngagement?: number;
  country?: string;
  activeDays?: number;
  limit?: number;
  category?: string;
  sortBy?: string;
  language?: string;
  region?: string;
}

export interface ParsedChannel {
  channelId: string;
  channelName: string;
  channelUrl: string;
  thumbnail: string;
  country: string;
  subscribers: number;
  avgViews: number;
  engagementRate: number;
  erNormalized: number;
  erFlags: string;
  email: string | null;
  telegram: string | null;
  instagram: string | null;
  twitter: string | null;
  tiktok: string | null;
  vk: string | null;
  discord: string | null;
  whatsapp: string | null;
  website: string | null;
  rawContacts: string;
  keyword: string;
  lastVideoDate: string | null;
  channelAboutText: string | null;
  channelTags: string | null;
  channelLanguage: string | null;
  mainCategory: string | null;
  channelAgeDays: number | null;
  lastVideosJson: string | null;
  topPlaylistsJson: string | null;
}

export interface ParseResult {
  found: number;
  newLeads: number;
  channels: ParsedChannel[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const _YT_CATEGORY_MAP: Record<string, string> = {
  "1": "Film & Animation",
  "2": "Autos & Vehicles",
  "10": "Music",
  "15": "Pets & Animals",
  "17": "Sports",
  "19": "Travel & Events",
  "20": "Gaming",
  "22": "People & Blogs",
  "23": "Comedy",
  "24": "Entertainment",
  "25": "News & Politics",
  "26": "Howto & Style",
  "27": "Education",
  "28": "Science & Technology",
  "29": "Nonprofits & Activism",
};

/** Approximate quota costs per YouTube API method */
const API_COSTS: Record<string, number> = {
  "search.list": 100,
  "channels.list": 1,
  "playlistItems.list": 1,
  "videos.list": 1,
};

// ═══════════════════════════════════════════════════════════════════════════
// Personal / Business Email Classification
// ═══════════════════════════════════════════════════════════════════════════

const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.co.jp",
  "yahoo.fr",
  "yahoo.de",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.ru",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "tutanota.com",
  "tutamail.com",
  "tuta.io",
  "zoho.com",
  "yandex.ru",
  "yandex.com",
  "yandex.ua",
  "yandex.by",
  "yandex.kz",
  "ya.ru",
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "internet.ru",
  "rambler.ru",
  "lenta.ru",
  "autorambler.ru",
  "myrambler.ru",
  "ro.ru",
  "ukr.net",
  "i.ua",
  "meta.ua",
  "bigmir.net",
  "email.ua",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "gmx.at",
  "web.de",
  "t-online.de",
  "freenet.de",
  "posteo.de",
  "mailbox.org",
  "fastmail.com",
  "fastmail.fm",
  "hushmail.com",
  "runbox.com",
  "mailfence.com",
  "disroot.org",
  "riseup.net",
  "cock.li",
  "mail.com",
  "email.com",
  "usa.com",
  "consultant.com",
  "engineer.com",
  "writeme.com",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  "sohu.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
]);

/** Regex patterns for emails that are NOT real business contacts */
const BUSINESS_EMAIL_BLACKLIST: RegExp[] = [
  /^noreply@/i,
  /^no-reply@/i,
  /^no\.reply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^abuse@/i,
  /^spam@/i,
  /^support@/i,
  /^help@/i,
  /^info@/i,
  /^admin@/i,
  /^webmaster@/i,
  /^hostmaster@/i,
  /^sales@/i,
  /^billing@/i,
  /^newsletter@/i,
  /^notifications?@/i,
  /^alerts?@/i,
  /^updates?@/i,
  /^feedback@/i,
  /^hello@/i,
  /^contact@/i,
  /^press@/i,
  /^media@/i,
  /^pr@/i,
  /^marketing@/i,
  /^partnerships?@/i,
  /^affiliate@/i,
  /^careers?@/i,
  /^jobs?@/i,
  /^hr@/i,
  /^recruit(ing|ment)?@/i,
  /^legal@/i,
  /^privacy@/i,
  /^security@/i,
  /^compliance@/i,
  /^dmca@/i,
  /^copyright@/i,
  /^takedown@/i,
  /^test@/i,
  /^demo@/i,
  /^example@/i,
  /^sample@/i,
  /^subscribe@/i,
  /^unsubscribe@/i,
  /^bounce@/i,
  /^returns?@/i,
  /^invoices?@/i,
  /^receipts?@/i,
  /^orders?@/i,
  /^shipping@/i,
  /^delivery@/i,
  /^tracking@/i,
];

function classifyEmail(email: string): "personal" | "business" | "unknown" {
  const lower = email.toLowerCase().trim();
  if (BUSINESS_EMAIL_BLACKLIST.some((rx) => rx.test(lower))) return "unknown";
  const domain = lower.split("@")[1];
  if (!domain) return "unknown";
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return "personal";
  return "business";
}

// ═══════════════════════════════════════════════════════════════════════════
// Contact Extraction
// ═══════════════════════════════════════════════════════════════════════════

/** Extract all email addresses from text */
function extractEmails(text: string): string[] {
  const rx = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(rx) || [];
  // Deduplicate, lowercase
  return Array.from(new Set(matches.map((e) => e.toLowerCase())));
}

/** Extract Telegram handles/links */
function extractTelegram(text: string): string[] {
  const patterns = [
    // t.me/username links
    /(?:https?:\/\/)?t(?:elegram)?\.me\/([a-zA-Z0-9_]{5,32})/gi,
    // @username mentions (Telegram style)
    /(?:telegram|тг|tg)\s*[:：\-–—]?\s*@?([a-zA-Z0-9_]{5,32})/gi,
    // Direct t.me/ without protocol
    /\bt\.me\/([a-zA-Z0-9_]{5,32})/gi,
  ];
  const results: string[] = [];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      const handle = m[1]!.toLowerCase();
      // Skip common false positives
      if (
        !["joinchat", "addstickers", "share", "proxy", "socks", "iv"].includes(
          handle,
        )
      ) {
        results.push(handle);
      }
    }
  }
  return Array.from(new Set(results));
}

/** Extract Instagram handles */
function extractInstagram(text: string): string[] {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]{1,30})\/?/gi,
    /(?:instagram|инстаграм|инста|ig)\s*[:：\-–—]?\s*@?([a-zA-Z0-9_.]{1,30})/gi,
  ];
  const results: string[] = [];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      const handle = m[1]!.toLowerCase();
      if (
        ![
          "p",
          "reel",
          "stories",
          "explore",
          "accounts",
          "about",
          "developer",
          "legal",
        ].includes(handle)
      ) {
        results.push(handle);
      }
    }
  }
  return Array.from(new Set(results));
}

/** Extract Twitter/X handles */
function extractTwitter(text: string): string[] {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]{1,15})\/?/gi,
    /(?:twitter|твиттер)\s*[:：\-–—]?\s*@?([a-zA-Z0-9_]{1,15})/gi,
  ];
  const results: string[] = [];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      const handle = m[1]!.toLowerCase();
      if (
        ![
          "intent",
          "share",
          "home",
          "search",
          "explore",
          "settings",
          "i",
          "hashtag",
        ].includes(handle)
      ) {
        results.push(handle);
      }
    }
  }
  return Array.from(new Set(results));
}

/** Extract TikTok handles */
function extractTiktok(text: string): string[] {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9_.]{1,24})\/?/gi,
    /(?:tiktok|тикток)\s*[:：\-–—]?\s*@?([a-zA-Z0-9_.]{1,24})/gi,
  ];
  const results: string[] = [];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      results.push(m[1]!.toLowerCase());
    }
  }
  return Array.from(new Set(results));
}

/** Extract VK handles */
function extractVk(text: string): string[] {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?vk\.com\/([a-zA-Z0-9_.]{1,32})\/?/gi,
    /(?:vk|вк|вконтакте|vkontakte)\s*[:：\-–—]?\s*@?([a-zA-Z0-9_.]{1,32})/gi,
  ];
  const results: string[] = [];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      const handle = m[1]!.toLowerCase();
      if (
        ![
          "wall",
          "feed",
          "friends",
          "groups",
          "public",
          "club",
          "id0",
          "away.php",
        ].includes(handle)
      ) {
        results.push(handle);
      }
    }
  }
  return Array.from(new Set(results));
}

/** Extract Discord invites */
function extractDiscord(text: string): string[] {
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9\-]{2,32})/gi,
    /(?:discord|дискорд)\s*[:：\-–—]?\s*([a-zA-Z0-9#\-]{2,37})/gi,
  ];
  const results: string[] = [];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      results.push(m[1]!);
    }
  }
  return Array.from(new Set(results));
}

/** Extract WhatsApp links/numbers */
function extractWhatsapp(text: string): string[] {
  const patterns = [
    /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?(\d{7,15})/gi,
    /(?:whatsapp|вотсап|ватсап|wa)\s*[:：\-–—]?\s*\+?(\d{7,15})/gi,
  ];
  const results: string[] = [];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      results.push(m[1]!);
    }
  }
  return Array.from(new Set(results));
}

/** Extract website URLs (non-social) */
function extractWebsite(text: string): string[] {
  const urlRx =
    /https?:\/\/(?:www\.)?([a-zA-Z0-9\-]+\.[a-zA-Z]{2,})(?:\/[^\s)"\]]*)?/gi;
  const socialDomains = new Set([
    "youtube.com",
    "youtu.be",
    "twitter.com",
    "x.com",
    "instagram.com",
    "facebook.com",
    "fb.com",
    "tiktok.com",
    "vk.com",
    "discord.gg",
    "discord.com",
    "t.me",
    "telegram.me",
    "wa.me",
    "whatsapp.com",
    "linkedin.com",
    "reddit.com",
    "twitch.tv",
    "pinterest.com",
    "tumblr.com",
    "snapchat.com",
    "threads.net",
    "patreon.com",
    "ko-fi.com",
    "buymeacoffee.com",
    "donationalerts.com",
    "boosty.to",
    "google.com",
    "goo.gl",
    "bit.ly",
  ]);
  const results: string[] = [];
  let m;
  while ((m = urlRx.exec(text)) !== null) {
    const domain = m[1]!.toLowerCase();
    if (!socialDomains.has(domain)) {
      results.push(m[0]);
    }
  }
  return Array.from(new Set(results));
}

interface ContactSource {
  text: string;
  label: string;
}

interface ExtractedContacts {
  email: string | null;
  emailType: "personal" | "business" | "unknown" | null;
  allEmails: { email: string; type: string; source: string }[];
  telegram: string | null;
  instagram: string | null;
  twitter: string | null;
  tiktok: string | null;
  vk: string | null;
  discord: string | null;
  whatsapp: string | null;
  website: string | null;
}

/**
 * Extract all contacts from multiple text sources (description, about, links).
 * Prioritizes business emails over personal, and deduplicates.
 */
function extractContacts(sources: ContactSource[]): ExtractedContacts {
  const allEmails: { email: string; type: string; source: string }[] = [];
  let telegram: string | null = null;
  let instagram: string | null = null;
  let twitter: string | null = null;
  let tiktok: string | null = null;
  let vk: string | null = null;
  let discord: string | null = null;
  let whatsapp: string | null = null;
  let website: string | null = null;

  for (const { text, label } of sources) {
    if (!text) continue;

    // Emails
    for (const e of extractEmails(text)) {
      const type = classifyEmail(e);
      if (type !== "unknown") {
        allEmails.push({ email: e, type, source: label });
      }
    }

    // Social handles — take first found
    if (!telegram) {
      const tg = extractTelegram(text);
      if (tg.length) telegram = tg[0] ?? null;
    }
    if (!instagram) {
      const ig = extractInstagram(text);
      if (ig.length) instagram = ig[0] ?? null;
    }
    if (!twitter) {
      const tw = extractTwitter(text);
      if (tw.length) twitter = tw[0] ?? null;
    }
    if (!tiktok) {
      const tt = extractTiktok(text);
      if (tt.length) tiktok = tt[0] ?? null;
    }
    if (!vk) {
      const v = extractVk(text);
      if (v.length) vk = v[0] ?? null;
    }
    if (!discord) {
      const d = extractDiscord(text);
      if (d.length) discord = d[0] ?? null;
    }
    if (!whatsapp) {
      const wa = extractWhatsapp(text);
      if (wa.length) whatsapp = wa[0] ?? null;
    }
    if (!website) {
      const w = extractWebsite(text);
      if (w.length) website = w[0] ?? null;
    }
  }

  // Pick best email: prefer business over personal
  const businessEmails = allEmails.filter((e) => e.type === "business");
  const personalEmails = allEmails.filter((e) => e.type === "personal");
  const bestEmail =
    businessEmails[0]?.email ?? personalEmails[0]?.email ?? null;
  const bestType = businessEmails[0]
    ? "business"
    : personalEmails[0]
      ? "personal"
      : null;

  return {
    email: bestEmail,
    emailType: bestType,
    allEmails,
    telegram,
    instagram,
    twitter,
    tiktok,
    vk,
    discord,
    whatsapp,
    website,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Engagement Rate Normalization
// ═══════════════════════════════════════════════════════════════════════════

function normalizeER(
  rawER: number,
  subs: number,
): { normalized: number; flags: string[] } {
  const flags: string[] = [];

  // Flag suspiciously high ER for large channels
  if (subs > 100000 && rawER > 15) {
    flags.push("suspiciously_high_er");
  }
  if (subs > 500000 && rawER > 10) {
    flags.push("high_er_large_channel");
  }

  // Flag very low ER
  if (rawER < 0.5) {
    flags.push("very_low_er");
  }

  // Normalize: scale ER relative to subscriber tier
  // Smaller channels naturally have higher ER
  let normalized = rawER;
  if (subs < 10000) {
    normalized = rawER * 0.6; // Small channels get penalized (inflated ER)
  } else if (subs < 50000) {
    normalized = rawER * 0.75;
  } else if (subs < 100000) {
    normalized = rawER * 0.85;
  } else if (subs < 500000) {
    normalized = rawER * 0.95;
  }
  // 500k+ keeps raw ER (already impressive if high)

  // Cap at 100
  normalized = Math.min(normalized, 100);

  return { normalized: Math.round(normalized * 100) / 100, flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a function with exponential backoff */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/** Simple in-memory cache for channel data within a parse run */
class ParseCache {
  private cache = new Map<string, { data: any; expires: number }>();
  private ttl: number;

  constructor(ttlMs = 300_000) {
    this.ttl = ttlMs;
  }

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  set(key: string, data: any): void {
    this.cache.set(key, { data, expires: Date.now() + this.ttl });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Parser
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the YouTube channel parser.
 *
 * Searches YouTube for videos matching keywords, extracts unique channels,
 * fetches channel details, calculates engagement, extracts contacts,
 * and upserts results as MktLead records.
 */
export async function runYouTubeParser(
  opts: ParseOptions,
  onProgress?: (msg: string) => void,
): Promise<ParseResult> {
  const log = (msg: string) => onProgress?.(msg);

  // 1. Load API key from MktConfig
  const config = await db.mktConfig.findUnique({
    where: { workspaceId: opts.workspaceId },
  });

  if (!config?.youtubeApiKey) {
    throw new Error(
      "YouTube API key not configured. Go to Marketing → Settings.",
    );
  }

  // NOTE: googleapis must be installed: pnpm add googleapis
  // Lazy import to avoid build errors if not yet installed
  let google: any;
  try {
    const mod = await import("googleapis");
    google = mod.google;
  } catch {
    throw new Error(
      "googleapis package not installed. Run: pnpm add googleapis",
    );
  }

  const youtube = google.youtube({
    version: "v3",
    auth: config.youtubeApiKey,
  });

  const _cache = new ParseCache();
  let quotaUsed = 0;

  const keywords = (opts.keywords || "")
    .split(",")
    .map((k: string) => k.trim())
    .filter(Boolean);

  if (!keywords.length) {
    throw new Error("At least one keyword is required");
  }

  const limit = opts.limit || 50;
  const allChannels: ParsedChannel[] = [];
  const seenChannelIds = new Set<string>();

  // 2. Search for videos by keywords
  for (const keyword of keywords) {
    log(`Searching for "${keyword}"...`);

    let searchQuery = keyword;
    if (opts.hashtags) {
      searchQuery +=
        " " +
        opts.hashtags
          .split(",")
          .map((h: string) => `#${h.trim()}`)
          .join(" ");
    }

    const searchParams: any = {
      part: "snippet",
      q: searchQuery,
      type: "video",
      maxResults: Math.min(limit, 50),
      order: opts.sortBy || "relevance",
    };
    if (opts.language) searchParams.relevanceLanguage = opts.language;
    if (opts.region) searchParams.regionCode = opts.region;
    if (opts.category) searchParams.videoCategoryId = opts.category;

    let searchResults: any;
    try {
      searchResults = await withRetry(() => youtube.search.list(searchParams));
      quotaUsed += API_COSTS["search.list"]!;
    } catch (err: any) {
      log(`Search failed for "${keyword}": ${err.message}`);
      continue;
    }

    const items = searchResults.data.items || [];
    log(`Found ${items.length} videos for "${keyword}"`);

    // 3. Extract unique channel IDs
    const channelIds: string[] = [];
    for (const item of items) {
      const cid = item.snippet?.channelId;
      if (cid && !seenChannelIds.has(cid)) {
        seenChannelIds.add(cid);
        channelIds.push(cid);
      }
    }

    if (!channelIds.length) continue;

    // 4. Batch fetch channel details (max 50 per request)
    log(`Fetching details for ${channelIds.length} channels...`);
    const batches: string[][] = [];
    for (let i = 0; i < channelIds.length; i += 50) {
      batches.push(channelIds.slice(i, i + 50));
    }

    for (const batch of batches) {
      let channelResponse: any;
      try {
        channelResponse = await withRetry(() =>
          youtube.channels.list({
            part: "snippet,statistics,contentDetails,brandingSettings,topicDetails",
            id: batch.join(","),
          }),
        );
        quotaUsed += API_COSTS["channels.list"]!;
      } catch (err: any) {
        log(`Channel fetch failed: ${err.message}`);
        continue;
      }

      const channels = channelResponse.data.items || [];

      for (const ch of channels) {
        const stats = ch.statistics || {};
        const snippet = ch.snippet || {};
        const branding = ch.brandingSettings || {};
        const subs = parseInt(stats.subscriberCount || "0", 10);
        const _viewCount = parseInt(stats.viewCount || "0", 10);
        const _videoCount = parseInt(stats.videoCount || "0", 10);

        // 5. Filter by subscriber count
        if (opts.minSubs && subs < opts.minSubs) continue;
        if (opts.maxSubs && subs > opts.maxSubs) continue;

        // Filter by country
        if (opts.country && snippet.country && snippet.country !== opts.country)
          continue;

        // 6. Fetch recent videos for engagement calculation
        const uploadsPlaylistId = ch.contentDetails?.relatedPlaylists?.uploads;
        let recentVideos: any[] = [];

        if (uploadsPlaylistId) {
          try {
            const plRes: any = await withRetry(() =>
              youtube.playlistItems.list({
                part: "snippet,contentDetails",
                playlistId: uploadsPlaylistId,
                maxResults: 10,
              }),
            );
            quotaUsed += API_COSTS["playlistItems.list"]!;
            recentVideos = plRes.data.items || [];
          } catch {
            // non-fatal
          }
        }

        // Fetch video statistics for engagement rate
        let videoStats: any[] = [];
        if (recentVideos.length > 0) {
          const videoIds = recentVideos
            .map((v: any) => v.contentDetails?.videoId)
            .filter(Boolean);
          if (videoIds.length) {
            try {
              const vRes: any = await withRetry(() =>
                youtube.videos.list({
                  part: "statistics,snippet",
                  id: videoIds.join(","),
                }),
              );
              quotaUsed += API_COSTS["videos.list"]!;
              videoStats = vRes.data.items || [];
            } catch {
              // non-fatal
            }
          }
        }

        // 7. Calculate engagement rate
        let avgViews = 0;
        let engagementRate = 0;
        const lastVideos: any[] = [];

        if (videoStats.length > 0) {
          let totalViews = 0;
          let totalEngagement = 0;

          for (const v of videoStats) {
            const vs = v.statistics || {};
            const views = parseInt(vs.viewCount || "0", 10);
            const likes = parseInt(vs.likeCount || "0", 10);
            const comments = parseInt(vs.commentCount || "0", 10);
            totalViews += views;
            totalEngagement += likes + comments;

            lastVideos.push({
              id: v.id,
              title: v.snippet?.title,
              publishedAt: v.snippet?.publishedAt,
              views,
              likes,
              comments,
            });
          }

          avgViews = Math.round(totalViews / videoStats.length);
          engagementRate =
            totalViews > 0
              ? Math.round((totalEngagement / totalViews) * 100 * 100) / 100
              : 0;
        }

        // Filter by minimum engagement
        if (opts.minEngagement && engagementRate < opts.minEngagement) continue;

        // Filter by activity (days since last video)
        let lastVideoDate: string | null = null;
        if (recentVideos.length > 0) {
          const publishedAt =
            recentVideos[0]?.snippet?.publishedAt ||
            recentVideos[0]?.contentDetails?.videoPublishedAt;
          if (publishedAt) {
            lastVideoDate = publishedAt;
            if (opts.activeDays) {
              const daysSince =
                (Date.now() - new Date(publishedAt).getTime()) /
                (1000 * 60 * 60 * 24);
              if (daysSince > opts.activeDays) continue;
            }
          }
        }

        // 8. ER normalization
        const { normalized: erNormalized, flags: erFlags } = normalizeER(
          engagementRate,
          subs,
        );

        // 9. Extract contacts from description/about/links
        const aboutText = snippet.description || "";
        const brandingDesc = branding.channel?.description || "";
        const brandingKeywords = branding.channel?.keywords || "";

        const contactSources: ContactSource[] = [
          { text: aboutText, label: "description" },
          { text: brandingDesc, label: "branding" },
          { text: brandingKeywords, label: "keywords" },
        ];

        // Also check links from channel
        if (branding.channel?.unsubscribedTrailer) {
          contactSources.push({
            text: branding.channel.unsubscribedTrailer,
            label: "trailer",
          });
        }

        const contacts = extractContacts(contactSources);

        // Channel age
        let channelAgeDays: number | null = null;
        if (snippet.publishedAt) {
          channelAgeDays = Math.floor(
            (Date.now() - new Date(snippet.publishedAt).getTime()) /
              (1000 * 60 * 60 * 24),
          );
        }

        // Topic / category
        const topicCategories = ch.topicDetails?.topicCategories || [];
        const mainCategory =
          topicCategories.length > 0
            ? topicCategories[0]
                .replace("https://en.wikipedia.org/wiki/", "")
                .replace(/_/g, " ")
            : null;

        const parsed: ParsedChannel = {
          channelId: ch.id,
          channelName: snippet.title || "",
          channelUrl: `https://www.youtube.com/channel/${ch.id}`,
          thumbnail:
            snippet.thumbnails?.medium?.url ||
            snippet.thumbnails?.default?.url ||
            "",
          country: snippet.country || "",
          subscribers: subs,
          avgViews,
          engagementRate,
          erNormalized,
          erFlags: JSON.stringify(erFlags),
          email: contacts.email,
          telegram: contacts.telegram,
          instagram: contacts.instagram,
          twitter: contacts.twitter,
          tiktok: contacts.tiktok,
          vk: contacts.vk,
          discord: contacts.discord,
          whatsapp: contacts.whatsapp,
          website: contacts.website,
          rawContacts: JSON.stringify(contacts),
          keyword,
          lastVideoDate,
          channelAboutText: aboutText.slice(0, 2000),
          channelTags: brandingKeywords
            ? JSON.stringify(brandingKeywords.split(/\s+/))
            : null,
          channelLanguage: snippet.defaultLanguage || null,
          mainCategory,
          channelAgeDays,
          lastVideosJson: lastVideos.length ? JSON.stringify(lastVideos) : null,
          topPlaylistsJson: null,
        };

        allChannels.push(parsed);
      }
    }

    // Rate limiting between keyword searches
    if (keywords.indexOf(keyword) < keywords.length - 1) {
      await sleep(500);
    }
  }

  // 10. Save to MktLead (upsert by channelId)
  log(`Saving ${allChannels.length} channels to database...`);
  let newLeads = 0;

  for (const ch of allChannels) {
    const existing = await db.mktLead.findUnique({
      where: {
        workspaceId_channelId: {
          workspaceId: opts.workspaceId,
          channelId: ch.channelId,
        },
      },
    });

    await db.mktLead.upsert({
      where: {
        workspaceId_channelId: {
          workspaceId: opts.workspaceId,
          channelId: ch.channelId,
        },
      },
      create: {
        workspaceId: opts.workspaceId,
        channelId: ch.channelId,
        channelName: ch.channelName,
        channelUrl: ch.channelUrl,
        thumbnail: ch.thumbnail,
        source: "YOUTUBE",
        country: ch.country,
        subscribers: ch.subscribers,
        avgViews: ch.avgViews,
        engagementRate: ch.engagementRate,
        erNormalized: ch.erNormalized,
        erFlags: ch.erFlags,
        email: ch.email,
        telegram: ch.telegram,
        instagram: ch.instagram,
        twitter: ch.twitter,
        tiktok: ch.tiktok,
        vk: ch.vk,
        discord: ch.discord,
        whatsapp: ch.whatsapp,
        website: ch.website,
        rawContacts: ch.rawContacts,
        channelAboutText: ch.channelAboutText,
        channelTags: ch.channelTags,
        channelLanguage: ch.channelLanguage,
        mainCategory: ch.mainCategory,
        channelAgeDays: ch.channelAgeDays,
        lastVideoDate: ch.lastVideoDate ? new Date(ch.lastVideoDate) : null,
        lastVideosJson: ch.lastVideosJson,
        topPlaylistsJson: ch.topPlaylistsJson,
        leadStatus: "PENDING",
        dialogueStage: "NOT_CONTACTED",
      },
      update: {
        channelName: ch.channelName,
        thumbnail: ch.thumbnail,
        subscribers: ch.subscribers,
        avgViews: ch.avgViews,
        engagementRate: ch.engagementRate,
        erNormalized: ch.erNormalized,
        erFlags: ch.erFlags,
        email: ch.email,
        telegram: ch.telegram,
        instagram: ch.instagram,
        twitter: ch.twitter,
        tiktok: ch.tiktok,
        vk: ch.vk,
        discord: ch.discord,
        whatsapp: ch.whatsapp,
        website: ch.website,
        rawContacts: ch.rawContacts,
        channelAboutText: ch.channelAboutText,
        channelTags: ch.channelTags,
        channelLanguage: ch.channelLanguage,
        mainCategory: ch.mainCategory,
        channelAgeDays: ch.channelAgeDays,
        lastVideoDate: ch.lastVideoDate ? new Date(ch.lastVideoDate) : null,
        lastVideosJson: ch.lastVideosJson,
        topPlaylistsJson: ch.topPlaylistsJson,
      },
    });

    if (!existing) newLeads++;

    // Also upsert email lookup if email found
    if (ch.email) {
      await db.mktLeadEmail.upsert({
        where: {
          leadId_email: {
            leadId: (await db.mktLead.findUnique({
              where: {
                workspaceId_channelId: {
                  workspaceId: opts.workspaceId,
                  channelId: ch.channelId,
                },
              },
              select: { id: true },
            }))!.id,
            email: ch.email,
          },
        },
        create: {
          leadId: (await db.mktLead.findUnique({
            where: {
              workspaceId_channelId: {
                workspaceId: opts.workspaceId,
                channelId: ch.channelId,
              },
            },
            select: { id: true },
          }))!.id,
          email: ch.email,
        },
        update: {},
      });
    }
  }

  log(
    `Done! Found ${allChannels.length} channels, ${newLeads} new leads. Quota used: ~${quotaUsed}`,
  );

  return {
    found: allChannels.length,
    newLeads,
    channels: allChannels,
  };
}
