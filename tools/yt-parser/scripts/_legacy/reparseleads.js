"use strict";
require("dotenv").config();
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const CACHE_FILE = path.join(__dirname, "..", "cache.json");
const db = new Database(path.join(__dirname, "..", "data", "parser.db"));
const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY,
});

const leads = db
  .prepare(
    `
  SELECT id, channel_id, channel_name
  FROM leads
  WHERE id != 155
    AND (last_videos_json IS NULL OR last_videos_json = '[]' OR last_videos_json = '')
`,
  )
  .all();

console.log(`Перепарсим ${leads.length} лидов...`);

const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
if (!cache.channels) cache.channels = {};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchChannel(channelId) {
  const res = await youtube.channels.list({
    part: "snippet,statistics,brandingSettings,contentDetails",
    id: channelId,
  });
  return (res.data.items || [])[0];
}

async function fetchVideos(uploadsPlaylistId) {
  if (!uploadsPlaylistId) return [];
  const res = await youtube.playlistItems.list({
    part: "snippet,contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: 10,
  });
  return (res.data.items || []).map((item) => ({
    title: item.snippet?.title || "",
    description: (item.snippet?.description || "").slice(0, 200),
    publishedAt: item.snippet?.publishedAt || "",
    views: 0,
  }));
}

async function main() {
  let done = 0;
  for (const lead of leads) {
    try {
      const ch = await fetchChannel(lead.channel_id);
      if (!ch) {
        console.log(`  [skip] ${lead.channel_name} — not found`);
        done++;
        continue;
      }

      const uploadsId = ch.contentDetails?.relatedPlaylists?.uploads;
      const videos = await fetchVideos(uploadsId);
      const about = (ch.snippet?.description || "").slice(0, 2000);
      const tags = ch.brandingSettings?.channel?.keywords || "";
      const publishedAt = ch.snippet?.publishedAt || "";
      const ageDays = publishedAt
        ? Math.floor(
            (Date.now() - new Date(publishedAt).getTime()) / (86400 * 1000),
          )
        : null;
      const lang =
        ch.snippet?.defaultLanguage || ch.snippet?.defaultAudioLanguage || "";

      const existing = cache.channels[lead.channel_id] || {};
      cache.channels[lead.channel_id] = {
        ...existing,
        channel_id: lead.channel_id,
        last_videos_json: JSON.stringify(videos),
        channel_about_text: about,
        channel_tags: tags,
        channel_age_days: ageDays,
        channel_language: lang,
        cached_at: new Date().toISOString(),
      };

      done++;
      console.log(
        `  [${done}/${leads.length}] OK ${lead.channel_name} — ${videos.length} видео, about: ${about.length} chars`,
      );
      await sleep(200);
    } catch (e) {
      console.error(`  [ERR] ${lead.channel_name}: ${e.message}`);
      done++;
    }
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\nГотово. cache.json обновлён.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
