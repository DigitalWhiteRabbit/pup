// Простой YouTube comments fetcher для deep-summary.
// Использует тот же YT_API_KEY что и парсер.
const { google } = require("googleapis");

let _yt = null;
function getYt() {
  if (_yt) return _yt;
  const key = process.env.YT_API_KEY || process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YT_API_KEY не задан в .env");
  _yt = google.youtube({ version: "v3", auth: key });
  return _yt;
}

// videos: [{ id?, videoId?, title }] — берём id любым доступным способом.
// Возвращает: [{ videoTitle, videoId, topComments: [{author, text, likes}] }]
async function fetchCommentsForVideos(videos, perVideo = 10) {
  if (!Array.isArray(videos) || videos.length === 0) return [];
  const yt = getYt();
  const out = [];
  for (const v of videos) {
    const videoId =
      v.videoId || v.id || (v.url && v.url.match(/[?&]v=([\w-]+)/)?.[1]);
    if (!videoId) continue;
    try {
      const r = await yt.commentThreads.list({
        videoId,
        part: "snippet",
        maxResults: perVideo,
        order: "relevance",
        textFormat: "plainText",
      });
      const items = r.data?.items || [];
      const topComments = items.map((it) => {
        const s = it.snippet?.topLevelComment?.snippet || {};
        return {
          author: (s.authorDisplayName || "").slice(0, 80),
          text: (s.textDisplay || "").slice(0, 400),
          likes: s.likeCount || 0,
        };
      });
      out.push({ videoTitle: v.title || "", videoId, topComments });
    } catch (e) {
      // Комменты могут быть выключены — это нормально, пропускаем.
      console.warn(`[yt-comments] ${videoId}: ${e.message}`);
      out.push({
        videoTitle: v.title || "",
        videoId,
        topComments: [],
        error: e.message,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return out;
}

// ─── Без API: yt-comment-scraper (скрейпинг HTML, 0 квоты) ───

let _scraper = null;
function getScraper() {
  if (_scraper) return _scraper;
  try {
    _scraper = require("yt-comment-scraper");
  } catch (e) {
    console.warn("[yt-comments] yt-comment-scraper не установлен:", e.message);
    _scraper = null;
  }
  return _scraper;
}

async function fetchCommentsNoApi(videoId, count = 20) {
  const scraper = getScraper();
  if (!scraper) return [];
  try {
    const payload = { videoId, sortBy: "top" };
    const result = await scraper.getComments(payload);
    if (!result || !Array.isArray(result.comments)) return [];
    return result.comments.slice(0, count).map((c) => ({
      author: (c.authorDisplayName || c.author || "").slice(0, 80),
      text: (c.textDisplay || c.text || "").slice(0, 400),
      likes: c.likes || c.likeCount || 0,
    }));
  } catch (e) {
    console.warn(`[yt-comments-scraper] ${videoId}:`, e.message);
    return [];
  }
}

async function fetchCommentsForVideosNoApi(videos, perVideo = 10) {
  if (!Array.isArray(videos) || videos.length === 0) return [];
  const out = [];
  for (const v of videos) {
    const videoId =
      v.videoId || v.id || (v.url && v.url.match(/[?&]v=([\w-]+)/)?.[1]);
    if (!videoId) continue;
    const topComments = await fetchCommentsNoApi(videoId, perVideo);
    out.push({ videoTitle: v.title || "", videoId, topComments });
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

module.exports = {
  fetchCommentsForVideos,
  fetchCommentsNoApi,
  fetchCommentsForVideosNoApi,
};
