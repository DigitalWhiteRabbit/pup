/**
 * Lead enrichment — fetch additional data from YouTube API before pitch generation.
 * Loads: last 10 videos (title, description, views, likes, tags, duration),
 * channel about, keywords, topicCategories.
 * Cost: ~3 API units per lead.
 */
const { google } = require("googleapis");

const API_KEY = process.env.YOUTUBE_API_KEY;

function getYoutube() {
  if (!API_KEY) return null;
  return google.youtube({ version: "v3", auth: API_KEY });
}

/**
 * Enrich a lead with YouTube data if missing.
 * @param {object} lead - lead row from DB
 * @param {object} db - better-sqlite3 database instance
 * @returns {object} enriched lead (mutated in-place + saved to DB)
 */
async function enrichLead(lead, db) {
  const youtube = getYoutube();
  if (!youtube) {
    console.log("[enrich] No YouTube API key, skipping");
    return lead;
  }

  const needsVideos = !lead.last_videos_json;
  const needsAbout = !lead.channel_about_text;
  const channelId = lead.channel_id;

  if (!channelId) return lead;
  if (!needsVideos && !needsAbout) {
    console.log(`[enrich] Lead #${lead.id} already enriched`);
    return lead;
  }

  console.log(
    `[enrich] Enriching lead #${lead.id} ${lead.channel_name} (videos=${needsVideos}, about=${needsAbout})`,
  );

  const now = new Date().toISOString();
  const updates = {};

  try {
    // 1. Channel details (about, keywords, topics) — 1 unit
    if (needsAbout) {
      const chRes = await youtube.channels.list({
        part: "snippet,brandingSettings,topicDetails,statistics",
        id: channelId,
      });
      const ch = chRes.data.items?.[0];
      if (ch) {
        const about =
          ch.brandingSettings?.channel?.description ||
          ch.snippet?.description ||
          "";
        const keywords = ch.brandingSettings?.channel?.keywords || "";
        const topics = (ch.topicDetails?.topicCategories || [])
          .map((url) => url.split("/").pop().replace(/_/g, " "))
          .join(", ");
        const language = ch.snippet?.defaultLanguage || "";
        const country = ch.snippet?.country || lead.country || "";
        const videoCount = ch.statistics?.videoCount;

        updates.channel_about_text = about.slice(0, 2000);

        // Re-extract contacts from about text if lead has none
        if (!lead.email || !lead.telegram) {
          const emailRx = /[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}/g;
          const tgLinkRx =
            /(?:https?:\/\/)?(?:t(?:elegram)?\.me)\/([a-zA-Z0-9_]{3,})/gi;
          const tgAtRx =
            /(?:telegram|\btg\b)[\s\S]{0,30}?@([a-zA-Z0-9_]{3,})/gi;
          const emails = about.match(emailRx) || [];
          const tgHandles = [];
          let mm;
          while ((mm = tgLinkRx.exec(about)) !== null) tgHandles.push(mm[1]);
          while ((mm = tgAtRx.exec(about)) !== null) tgHandles.push(mm[1]);
          if (emails.length > 0 && !lead.email) updates.email = emails[0];
          if (tgHandles.length > 0 && !lead.telegram)
            updates.telegram = [...new Set(tgHandles)].join(";");
        }
        if (keywords) updates.channel_tags = keywords.slice(0, 1000);
        if (topics) updates.main_category = topics.slice(0, 500);
        if (language && !lead.channel_language)
          updates.channel_language = language;
        if (country && !lead.country) updates.country = country;

        console.log(
          `[enrich] Channel about: ${about.length} chars, topics: ${topics}`,
        );
      }
    }

    // 2. Last 10 videos — 2 units (playlistItems + videos.list)
    if (needsVideos) {
      // Get uploads playlist ID
      const uploadsId = "UU" + channelId.slice(2); // UC... → UU...

      const plRes = await youtube.playlistItems.list({
        part: "snippet",
        playlistId: uploadsId,
        maxResults: 10,
      });

      const videoIds = (plRes.data.items || [])
        .map((i) => i.snippet?.resourceId?.videoId)
        .filter(Boolean);

      if (videoIds.length > 0) {
        const vRes = await youtube.videos.list({
          part: "snippet,statistics,contentDetails",
          id: videoIds.join(","),
        });

        const videos = (vRes.data.items || []).map((v) => ({
          videoId: v.id,
          title: v.snippet?.title || "",
          description: (v.snippet?.description || "").slice(0, 500),
          views: parseInt(v.statistics?.viewCount || "0"),
          likes: parseInt(v.statistics?.likeCount || "0"),
          comments: parseInt(v.statistics?.commentCount || "0"),
          tags: (v.snippet?.tags || []).slice(0, 10),
          duration: v.contentDetails?.duration || "",
          publishedAt: v.snippet?.publishedAt || "",
        }));

        updates.last_videos_json = JSON.stringify(videos);
        console.log(
          `[enrich] Loaded ${videos.length} videos for ${lead.channel_name}`,
        );
      }
    }

    // Save to DB
    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates)
        .map((k) => `${k} = ?`)
        .concat(["enriched_at = ?"])
        .join(", ");
      const values = Object.values(updates).concat([now, lead.id]);
      db.prepare(`UPDATE leads SET ${setClauses} WHERE id = ?`).run(...values);

      // Update lead object in-place
      Object.assign(lead, updates, { enriched_at: now });
      console.log(
        `[enrich] Saved ${Object.keys(updates).length} fields for lead #${lead.id}`,
      );
    }
  } catch (e) {
    console.error(`[enrich] Error for lead #${lead.id}:`, e.message);
  }

  return lead;
}

module.exports = { enrichLead };
