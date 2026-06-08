// Записывает пул тем (subject_pool) для промо-кампании id=2. Мягко-оффёрные, часть с {name}.
// Запуск из /var/www/yt-parser: node scripts/seed-subject-pool.js <ws.db>
const Database = require("better-sqlite3");
const db = new Database(process.argv[2]);

const proj = db.prepare("SELECT id, name FROM projects WHERE id = 2").get();
if (!proj || !/Промо/.test(proj.name)) {
  console.error("id=2 не промо-кампания — отмена");
  process.exit(1);
}

const pool = {
  en: [
    "early access for your audience",
    "{name}, an early look before we go public",
    "creators first — before our june 15 launch",
    "a new web3 project for your followers",
    "your audience + a new on-chain project",
    "{name}, want an early spot?",
    "something new for your crypto audience",
    "a smart-contract project worth a look",
    "{name}, this might fit your channel",
    "new web3 launch — inviting creators first",
    "{name}, an early idea for your community",
    "before we open this to everyone",
  ],
  ru: [
    "ранний доступ для твоей аудитории",
    "{name}, ранний взгляд до публичного старта",
    "сначала создатели — до запуска 15 июня",
    "новый web3-проект для твоих подписчиков",
    "твоя аудитория и новый on-chain проект",
    "{name}, зайдёшь одним из первых?",
    "кое-что новое для твоей крипто-аудитории",
    "проект на смарт-контракте — стоит взглянуть",
    "{name}, кажется, подойдёт твоему каналу",
    "до того как откроем для всех",
  ],
};

db.prepare(
  "UPDATE projects SET subject_pool = ?, updated_at = ? WHERE id = 2",
).run(JSON.stringify(pool), new Date().toISOString());
console.log(
  `OK: subject_pool записан для id=2 (EN ${pool.en.length}, RU ${pool.ru.length}; с {name}: EN ${pool.en.filter((s) => s.includes("{name}")).length}, RU ${pool.ru.filter((s) => s.includes("{name}")).length})`,
);
