// Тестовая генерация промо-питчей (НЕ шлёт письма). Зеркалит гейт воркера:
// если content_summary пуст → generateContentSummary + save → generateInitialPitch.
// Запуск из /var/www/yt-parser: node scripts/test-promo-pitch.js <ws.db> <leadId...>
require("dotenv").config();
const Database = require("better-sqlite3");
const ai = require("../services/ai");

const dbPath = process.argv[2];
const leadIds = process.argv.slice(3).map(Number);
const db = new Database(dbPath);

(async () => {
  const project = db.prepare("SELECT * FROM projects WHERE id = 2").get();
  console.log(
    `Кампания: ${project.name} | temp=${project.pitch_temperature} | lang=${project.language}`,
  );
  for (const id of leadIds) {
    const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
    if (!lead) {
      console.log(`lead #${id} не найден`);
      continue;
    }
    let autogen = false;
    if (!lead.content_summary) {
      try {
        const summary = await ai.generateContentSummary(lead, project);
        db.prepare(
          "UPDATE leads SET content_summary = ?, updated_at = ? WHERE id = ?",
        ).run(summary, new Date().toISOString(), lead.id);
        lead.content_summary = summary;
        autogen = true;
      } catch (e) {
        console.log(`summary fail #${id}: ${e.message}`);
      }
    }
    const pitch = await ai.generateInitialPitch(lead, project, "email");
    console.log("\n══════════════════════════════════════════════════════════");
    console.log(`LEAD #${id} — ${lead.channel_name}  [kw: ${lead.keyword}]`);
    console.log(
      `content_summary: ${autogen ? "✅ СГЕНЕРИРОВАНА АВТОМАТИЧЕСКИ" : "была ранее (не трогали)"}`,
    );
    console.log(`SUBJECT: ${pitch.subject}`);
    console.log(`BODY:\n${pitch.body}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
