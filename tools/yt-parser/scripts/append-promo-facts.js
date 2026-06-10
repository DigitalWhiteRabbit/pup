// One-off: дописать блок «ФАКТЫ ATLAS» в КОНЕЦ system_prompt промо-кампании (id=2).
// Бэкап текущего значения в файл. Идемпотентно. Платную (id=1) не трогает.
// Запуск из /var/www/yt-parser: node scripts/append-promo-facts.js <ws.db>
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node scripts/append-promo-facts.js <ws.db>");
  process.exit(1);
}
const db = new Database(dbPath);

const MARKER = "═══ ФАКТЫ ATLAS";
const BLOCK = `

═══ ФАКТЫ ATLAS (использовать ТОЛЬКО когда блогер задаёт вопросы) ═══
Отвечай по сути, коротко, без обещаний дохода.
- Что это: цифровой фонд взаимопомощи на базе Smart Cycle, всё на смарт-контракте BEP-20, on-chain, правила зафиксированы заранее и не меняются, без ручного управления админами, проверяемо на BSCScan. DAO-управление — направление выбирает сообщество голосованием.
- Smart Cycle: участник выбирает срок цикла → «даёт помощь» → по окончании срока «запрашивает помощь» обратно вместе с дельтой по заранее известным правилам цикла.
- Партнёрская программа (Invite & Earn): процент от структуры растёт со статусом, без ограничения по глубине; приглашённые партнёры остаются в твоём дереве навсегда по всем продуктам Atlas; зачисление — после первого цикла.
- Экосистема вокруг Smart Cycle: кошелёк, P2P-обмен, академия, governance и другие инструменты.
- Честные ожидания: модель не бесконечная, у каждого цикла есть начало и конец, результат не гарантирован — так и говори, не приукрашивай.
- ⛔ НЕ называй в письме конкретные цифры доходности / проценты дельты и НЕ обещай прибыль. За точными условиями, тирами и цифрами веди на лендинг join.atlas-system.io и в Telegram к менеджеру @daniel_cross_atlas_system — там покажут детали.`;

const proj = db
  .prepare("SELECT id, name, system_prompt FROM projects WHERE id = 2")
  .get();
if (!proj) {
  console.error("Кампания id=2 не найдена — отмена");
  process.exit(1);
}
if (!/Промо/.test(proj.name)) {
  console.error(`id=2 это не промо-кампания (name=${proj.name}) — отмена`);
  process.exit(1);
}

const cur = proj.system_prompt || "";

// Бэкап текущего значения.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const bakPath = path.join(__dirname, `system_prompt-id2.bak-${stamp}.txt`);
fs.writeFileSync(bakPath, cur, "utf-8");
console.log(`Бэкап: ${bakPath} (${cur.length} симв.)`);

if (cur.includes(MARKER)) {
  console.log("SKIP: блок ФАКТЫ ATLAS уже присутствует — апдейт не нужен");
  process.exit(0);
}

const next = cur + BLOCK;
db.prepare(
  "UPDATE projects SET system_prompt = ?, updated_at = ? WHERE id = 2",
).run(next, new Date().toISOString());
console.log(
  `OK: system_prompt id=2 обновлён: ${cur.length} → ${next.length} симв.`,
);
