const { parseCsv } = require("../utils/csv");
const { getDb, syncLeadEmails } = require("./database");

function extractChannelId(channelUrl) {
  if (!channelUrl) return null;
  const m =
    channelUrl.match(/channel\/([^/?]+)/) ||
    channelUrl.match(/youtube\.com\/(@[^/?]+)/);
  return m ? m[1] : null;
}

function hasAnyContact(row) {
  const fields = [
    "email",
    "telegram",
    "whatsapp",
    "instagram",
    "twitter",
    "tiktok",
    "vk",
    "discord",
    "website",
  ];
  return fields.some((f) => row[f] && String(row[f]).trim());
}

/**
 * Импортирует строки из CSV в таблицу leads.
 * Только лиды с хотя бы одним контактом.
 * INSERT OR IGNORE — дубликаты по channel_id пропускаются.
 */
function importFromCsv(csvPath, workspaceId) {
  const { db, stmts } = getDb(workspaceId);
  const rows = parseCsv(csvPath);
  if (rows.length === 0) return { imported: 0, skipped: 0, total: 0 };

  const now = new Date().toISOString();
  let imported = 0;
  let skipped = 0;

  const tx = db.transaction((rowsArr) => {
    for (const row of rowsArr) {
      const channelId = extractChannelId(row.channel_url) || row.channel_name;
      if (!channelId) {
        skipped++;
        continue;
      }
      if (!hasAnyContact(row)) {
        skipped++;
        continue;
      }

      const rawContacts = JSON.stringify({
        email: row.email || "",
        telegram: row.telegram || "",
        instagram: row.instagram || "",
        twitter: row.twitter || "",
        tiktok: row.tiktok || "",
        vk: row.vk || "",
        discord: row.discord || "",
        whatsapp: row.whatsapp || "",
        website: row.website || "",
      });

      const result = stmts.insertLead.run({
        channel_id: channelId,
        channel_name: row.channel_name || "",
        channel_url: row.channel_url || "",
        thumbnail: row.thumbnail || "",
        country: row.country || "",
        subscribers: row.subscribers || 0,
        avg_views: row.avg_views_per_video || 0,
        engagement_rate: row.engagement_rate || 0,
        email: row.email || "",
        telegram: row.telegram || "",
        whatsapp: row.whatsapp || "",
        raw_contacts: rawContacts,
        keyword: row.keyword || "",
        created_at: now,
        updated_at: now,
      });

      if (result.changes > 0) {
        imported++;
        if (row.email) {
          try {
            syncLeadEmails(workspaceId, result.lastInsertRowid, row.email);
          } catch (e) {
            /* non-fatal */
          }
        }
      } else skipped++; // already existed
    }
  });

  tx(rows);

  return { imported, skipped, total: rows.length };
}

module.exports = { importFromCsv };
