"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const CACHE_FILE = path.join(__dirname, "..", "cache.json");
const db = new Database(path.join(__dirname, "..", "data", "parser.db"));

const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
const channels = cache.channels || {};

const leads = db
  .prepare(`SELECT id, channel_id, channel_name FROM leads WHERE id != 155`)
  .all();
const now = new Date().toISOString();

const updateStmt = db.prepare(`
  UPDATE leads SET
    last_videos_json = @last_videos_json,
    channel_about_text = @channel_about_text,
    channel_tags = @channel_tags,
    channel_age_days = @channel_age_days,
    channel_language = @channel_language,
    enriched_at = @enriched_at
  WHERE id = @id
`);

let ok = 0,
  skip = 0;
for (const lead of leads) {
  const c = channels[lead.channel_id];
  if (!c) {
    skip++;
    continue;
  }
  if (!c.last_videos_json || c.last_videos_json === "[]") {
    skip++;
    continue;
  }

  updateStmt.run({
    id: lead.id,
    last_videos_json: c.last_videos_json || null,
    channel_about_text: c.channel_about_text || null,
    channel_tags: c.channel_tags || null,
    channel_age_days:
      c.channel_age_days != null ? Number(c.channel_age_days) : null,
    channel_language: c.channel_language || null,
    enriched_at: now,
  });
  ok++;
  console.log(`  OK ${lead.id} ${lead.channel_name.slice(0, 40)}`);
}

console.log(`\nОбновлено: ${ok}, пропущено: ${skip}`);
