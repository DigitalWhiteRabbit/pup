const fs = require("fs");

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  const rows = splitCsvRows(content);
  if (rows.length < 2) return [];

  const headers = parseCSVLine(rows[0]);
  const results = [];

  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (!line.trim()) continue;
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    row.subscribers = parseInt(row.subscribers, 10) || 0;
    row.total_views = parseInt(row.total_views, 10) || 0;
    row.video_count = parseInt(row.video_count, 10) || 0;
    row.avg_views_per_video = parseInt(row.avg_views_per_video, 10) || 0;
    row.engagement_rate = parseFloat(row.engagement_rate) || 0;
    for (const f of [
      "telegram",
      "instagram",
      "twitter",
      "tiktok",
      "vk",
      "discord",
      "whatsapp",
      "website",
    ]) {
      if (row[f] === undefined) row[f] = "";
    }
    results.push(row);
  }
  return results;
}

function splitCsvRows(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '""';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
        current += ch;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        current += ch;
      } else if (ch === "\n") {
        rows.push(current);
        current = "";
      } else if (ch === "\r") {
        /* skip */
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) rows.push(current);
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

module.exports = { parseCsv };
