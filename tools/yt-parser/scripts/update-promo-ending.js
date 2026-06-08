// Обновляет концовку промо-писем (id=2): чёткий вопрос + контакты столбиком + подпись.
// Правит system_prompt (пункты 4–6 → 4–7) и sample_pitches (4 эталона). Бэкап обоих полей.
// Запуск из /var/www/yt-parser: node scripts/update-promo-ending.js <ws.db>
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.argv[2];
const db = new Database(dbPath);

const proj = db
  .prepare(
    "SELECT id, name, system_prompt, sample_pitches FROM projects WHERE id = 2",
  )
  .get();
if (!proj || !/Промо/.test(proj.name)) {
  console.error("id=2 не промо-кампания — отмена");
  process.exit(1);
}

// ── Бэкап ──
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.writeFileSync(
  path.join(__dirname, `promo-id2-system_prompt.bak-${stamp}.txt`),
  proj.system_prompt || "",
);
fs.writeFileSync(
  path.join(__dirname, `promo-id2-sample_pitches.bak-${stamp}.json`),
  proj.sample_pitches || "",
);
console.log(`Бэкап system_prompt + sample_pitches → scripts/*.bak-${stamp}`);

// ── 1. system_prompt: заменить пункты 4–6 на 4–7 ──
const OLD_BLOCK = `4. Заверши мягким вопросом-приглашением посмотреть («Интересно глянуть?») — без давления, без «уникальное предложение!!!».
5. В ЭТОМ письме РАЗРЕШЕНО и НУЖНО оставить контакты: Telegram @daniel_cross_atlas_system, приглашение ответить на письмо, и ссылку join.atlas-system.io. Это осознанный one-shot, а не воронка на reply.
6. Длина тела ~80–100 слов + строка контактов. Без HTML, без CAPS, максимум 0–1 emoji.`;

const NEW_BLOCK = `4. Заверши письмо ОДНИМ коротким мягким вопросом-приглашением, отдельной строкой («Интересно глянуть?» / «Worth a look?»). Без давления и БЕЗ размытых обоснований вроде «показалось естественным выбором» — только чёткий короткий вопрос.
5. ПОСЛЕ вопроса — блок контактов, КАЖДЫЙ ПУНКТ С НОВОЙ СТРОКИ (НЕ в одну строку через «·»), в таком виде и порядке (метки на языке письма — RU: «Сайт:», «Или просто ответь на это письмо»; EN: «Site:», «Or just reply to this email»):
   Telegram: @daniel_cross_atlas_system
   Сайт: join.atlas-system.io
   Или просто ответь на это письмо
   Это осознанный one-shot с контактами, а не воронка на reply.
6. Подпись — последней строкой, через пустую строку от блока контактов: «— Daniel Cross, Atlas System». Подпись НЕ склеивай со ссылкой.
7. Длина основного текста ~80–100 слов (блок контактов и подпись не в счёт). Без HTML, без CAPS, максимум 0–1 emoji.`;

if (!proj.system_prompt.includes(OLD_BLOCK)) {
  if (proj.system_prompt.includes("Подпись НЕ склеивай со ссылкой")) {
    console.log("SKIP system_prompt: уже обновлён");
  } else {
    console.error(
      "ВНИМАНИЕ: старый блок пунктов 4–6 не найден — system_prompt не изменён",
    );
  }
}
const newSystem = proj.system_prompt.replace(OLD_BLOCK, NEW_BLOCK);

// ── 2. sample_pitches: новые концовки (вопрос + контакты столбиком + подпись) ──
const END_RU = `\n\nИнтересно глянуть?\n\nTelegram: @daniel_cross_atlas_system\nСайт: join.atlas-system.io\nИли просто ответь на это письмо\n\n— Daniel Cross, Atlas System`;
const END_EN = `\n\nWorth a look?\n\nTelegram: @daniel_cross_atlas_system\nSite: join.atlas-system.io\nOr just reply to this email\n\n— Daniel Cross, Atlas System`;

const samples = [
  {
    type: "good",
    label: "крипто/Web3 review, EN — грань: смарт-контракт/прозрачность",
    channel_context: "DeFi/Web3 review channel",
    subject: "saw your web3 coverage",
    body:
      "Hey [name] — Daniel Cross from Atlas System. Came across your channel and the Web3 community you've built really stood out.\n\nWe launch June 15: Atlas System, a next-generation digital mutual-aid fund where the whole mechanism runs on a BEP-20 smart contract — fixed rules, fully on-chain, verifiable on BSCScan, no admin control. It's pre-launch now, and we're letting the first creators show it to their audience before everyone else." +
      END_EN,
    why: "Грань под нишу (tech-прозрачность); концовка: чёткий вопрос + контакты столбиком + подпись.",
  },
  {
    type: "good",
    label: "пассивный доход, RU — грань: партнёрская программа",
    channel_context: "канал про пассивный доход",
    subject: "про твой контент о пассивном доходе",
    body:
      "Привет, [имя]! Это Daniel Cross из Atlas System. Заглянул на твой канал — то, как ты разбираешь тему пассивного дохода, реально цепляет аудиторию.\n\n15 июня запускаем Atlas System — цифровой фонд взаимопомощи на смарт-контракте. Для твоей аудитории особенно интересна партнёрская программа: процент от структуры без ограничения по глубине, а приглашённые остаются в твоём дереве навсегда. Сейчас пред-старт — заходим первыми, пока поляна свободна." +
      END_RU,
    why: "Другая грань (рефералка), другой язык; концовка столбиком.",
  },
  {
    type: "good",
    label: "комьюнити/мотивация, EN — грань: манифест/DAO",
    channel_context: "community / mindset channel",
    subject: "your take on community",
    body:
      "Hey [name] — Daniel Cross from Atlas System. Your channel and the way you talk to your community really resonated.\n\nWe're launching Atlas System on June 15 — a digital take on mutual aid: people pooling support under transparent, fixed rules, with direction set by the community through DAO voting rather than a company. It's honest by design — every cycle has a start and an end, nothing hidden. Pre-launch is open to the first creators now." +
      END_EN,
    why: "Грань — манифест/DAO; концовка столбиком.",
  },
  {
    type: "good",
    label: "инвестиции/трейдинг, RU — грань: Smart Cycle + честные ожидания",
    channel_context: "канал с разборами для инвесторов",
    subject: "про твои разборы для инвесторов",
    body:
      "Привет, [имя]! Это Daniel Cross из Atlas System. Смотрел твой канал — толковые разборы для аудитории, которая считает деньги.\n\n15 июня стартует Atlas System. В основе — Smart Cycle: выбираешь срок цикла, участвуешь, по окончании забираешь обратно с дельтой по заранее фиксированным правилам смарт-контракта. Без ручного управления, всё on-chain и проверяемо. Важно: модель честная и не бесконечная — правила известны заранее. Сейчас пред-старт, впускаем первых." +
      END_RU,
    why: "Грань — Smart Cycle + честные ожидания; концовка столбиком.",
  },
];
const sampleStr = JSON.stringify(samples);
JSON.parse(sampleStr); // валидация

db.prepare(
  "UPDATE projects SET system_prompt = ?, sample_pitches = ?, updated_at = ? WHERE id = 2",
).run(newSystem, sampleStr, new Date().toISOString());

console.log(
  `OK: system_prompt ${proj.system_prompt.length}→${newSystem.length}, sample_pitches обновлены (4 эталона, валидный JSON)`,
);
