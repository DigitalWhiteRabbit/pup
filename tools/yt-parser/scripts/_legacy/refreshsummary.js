"use strict";
require("dotenv").config();
const Database = require("better-sqlite3");
const path = require("path");
const ai = require("../services/ai");

const db = new Database(path.join(__dirname, "..", "data", "parser.db"));
const staleIds = [
  133, 134, 135, 136, 137, 138, 140, 141, 142, 145, 148, 149, 150, 152, 153,
  156, 157,
];
const leads = db
  .prepare(`SELECT * FROM leads WHERE id IN (${staleIds.join(",")})`)
  .all();
const updateStmt = db.prepare(
  `UPDATE leads SET content_summary=?, updated_at=? WHERE id=?`,
);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const activeProject =
    db.prepare(`SELECT * FROM projects WHERE is_active = 1 LIMIT 1`).get() ||
    null;
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    try {
      const project =
        (lead.project_id
          ? db
              .prepare(`SELECT * FROM projects WHERE id = ?`)
              .get(lead.project_id)
          : null) || activeProject;
      const summary = await ai.generateContentSummary(lead, project);
      updateStmt.run(summary, new Date().toISOString(), lead.id);
      const s = JSON.parse(summary);
      const topics = s.recent_topics || [];
      console.log(
        `[${i + 1}/${leads.length}] OK ${lead.channel_name.slice(0, 35)}`,
      );
      console.log(`  topics: ${topics.slice(0, 3).join(" | ")}`);
    } catch (e) {
      console.error(
        `[${i + 1}/${leads.length}] ERR ${lead.channel_name}: ${e.message}`,
      );
    }
    await sleep(400);
  }
  console.log("\nГотово.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
