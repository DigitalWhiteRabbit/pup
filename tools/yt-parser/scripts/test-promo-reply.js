// Симуляция ответа агента на входящий reply блогера по промо-кампании (id=2). Ничего не шлёт.
// Запуск из /var/www/yt-parser: node scripts/test-promo-reply.js <ws.db> <leadId>
require("dotenv").config();
const Database = require("better-sqlite3");
const ai = require("../services/ai");

const dbPath = process.argv[2];
const leadId = Number(process.argv[3] || 2);
const db = new Database(dbPath);

(async () => {
  const project = db.prepare("SELECT * FROM projects WHERE id = 2").get();
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
  console.log(
    `Кампания: ${project.name} | lead #${leadId}: ${lead.channel_name}`,
  );

  // Диалог: наше первое письмо (out) + входящий вопрос блогера (in, последний).
  const history = [
    {
      direction: "out",
      content:
        "Hey — Daniel Cross from Atlas System. Loved your crypto breakdowns. We launch June 15 — a mutual-aid fund on a BEP-20 smart contract, fully on-chain. Pre-launch is open to first creators. Want to take a look?",
    },
    {
      direction: "in",
      content: "sounds interesting, how does it work and what do I earn?",
    },
  ];

  const reply = await ai.generateReply(lead, project, history, "email");
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(
    "ВХОДЯЩИЙ: sounds interesting, how does it work and what do I earn?",
  );
  console.log("──────────────────────────────────────────────────────────");
  if (reply.subject) console.log(`SUBJECT: ${reply.subject}`);
  console.log(`ОТВЕТ АГЕНТА:\n${reply.body}`);
  if (reply.flag) console.log(`\n[flag: ${reply.flag}]`);
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
