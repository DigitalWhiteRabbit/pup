// Меняет закрывающий вопрос промо-писем (id=2) на ясный «пришлю подробности здесь
// или в Telegram», убирает строку «ответь на письмо». Правит system_prompt (п.4–5)
// и sample_pitches. Бэкап обоих полей.
// Запуск из /var/www/yt-parser: node scripts/update-promo-ending2.js <ws.db>
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(process.argv[2]);
const proj = db
  .prepare(
    "SELECT id, name, system_prompt, sample_pitches FROM projects WHERE id = 2",
  )
  .get();
if (!proj || !/Промо/.test(proj.name)) {
  console.error("id=2 не промо-кампания — отмена");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.writeFileSync(
  path.join(__dirname, `promo-id2-system_prompt.bak-${stamp}.txt`),
  proj.system_prompt || "",
);
fs.writeFileSync(
  path.join(__dirname, `promo-id2-sample_pitches.bak-${stamp}.json`),
  proj.sample_pitches || "",
);
console.log(`Бэкап → scripts/*.bak-${stamp}`);

const OLD = `4. Заверши письмо ОДНИМ коротким мягким вопросом-приглашением, отдельной строкой («Интересно глянуть?» / «Worth a look?»). Без давления и БЕЗ размытых обоснований вроде «показалось естественным выбором» — только чёткий короткий вопрос.
5. ПОСЛЕ вопроса — блок контактов, КАЖДЫЙ ПУНКТ С НОВОЙ СТРОКИ (НЕ в одну строку через «·»), в таком виде и порядке (метки на языке письма — RU: «Сайт:», «Или просто ответь на это письмо»; EN: «Site:», «Or just reply to this email»):
   Telegram: @daniel_cross_atlas_system
   Сайт: join.atlas-system.io
   Или просто ответь на это письмо
   Это осознанный one-shot с контактами, а не воронка на reply.`;

const NEW = `4. Заверши письмо ОДНИМ ясным мягким предложением-вопросом, отдельной строкой: предложи рассказать подробнее и дай выбор канала. RU: «Если интересно — пришлю подробности здесь или продолжим в Telegram — как удобнее.»; EN: «If you're interested, I can send the details here or continue over Telegram — whichever works for you.». Без давления и размытых обоснований; НЕ используй короткий обрубок вроде «Стоит посмотреть?» / «Worth a look?».
5. ПОСЛЕ вопроса — блок контактов, КАЖДЫЙ ПУНКТ С НОВОЙ СТРОКИ (НЕ в одну строку через «·»), ровно ДВЕ строки (метку «Сайт:/Site:» — на языке письма):
   Telegram: @daniel_cross_atlas_system
   Сайт: join.atlas-system.io
   НЕ добавляй строку «ответь на письмо/just reply» — выбор канала уже дан в вопросе выше. Это осознанный one-shot с контактами, а не воронка на reply.`;

let newSystem = proj.system_prompt;
if (proj.system_prompt.includes(OLD)) {
  newSystem = proj.system_prompt.replace(OLD, NEW);
} else if (
  proj.system_prompt.includes(
    "пришлю подробности здесь или продолжим в Telegram",
  )
) {
  console.log("SKIP system_prompt: уже обновлён");
} else {
  console.error(
    "ВНИМАНИЕ: старый блок п.4–5 не найден — system_prompt НЕ изменён",
  );
}

// sample_pitches: новые концовки (вопрос с выбором канала, без строки «ответь»)
const END_RU = `\n\nЕсли интересно — пришлю подробности здесь или продолжим в Telegram — как удобнее.\n\nTelegram: @daniel_cross_atlas_system\nСайт: join.atlas-system.io\n\n— Daniel Cross, Atlas System`;
const END_EN = `\n\nIf you're interested, I can send the details here or continue over Telegram — whichever works for you.\n\nTelegram: @daniel_cross_atlas_system\nSite: join.atlas-system.io\n\n— Daniel Cross, Atlas System`;

const BODIES = [
  "Hey [name] — Daniel Cross from Atlas System. Came across your channel and the Web3 community you've built really stood out.\n\nWe launch June 15: Atlas System, a next-generation digital mutual-aid fund where the whole mechanism runs on a BEP-20 smart contract — fixed rules, fully on-chain, verifiable on BSCScan, no admin control. It's pre-launch now, and we're letting the first creators show it to their audience before everyone else.",
  "Привет, [имя]! Это Daniel Cross из Atlas System. Заглянул на твой канал — то, как ты разбираешь тему пассивного дохода, реально цепляет аудиторию.\n\n15 июня запускаем Atlas System — цифровой фонд взаимопомощи на смарт-контракте. Для твоей аудитории особенно интересна партнёрская программа: процент от структуры без ограничения по глубине, а приглашённые остаются в твоём дереве навсегда. Сейчас пред-старт — заходим первыми, пока поляна свободна.",
  "Hey [name] — Daniel Cross from Atlas System. Your channel and the way you talk to your community really resonated.\n\nWe're launching Atlas System on June 15 — a digital take on mutual aid: people pooling support under transparent, fixed rules, with direction set by the community through DAO voting rather than a company. It's honest by design — every cycle has a start and an end, nothing hidden. Pre-launch is open to the first creators now.",
  "Привет, [имя]! Это Daniel Cross из Atlas System. Смотрел твой канал — толковые разборы для аудитории, которая считает деньги.\n\n15 июня стартует Atlas System. В основе — Smart Cycle: выбираешь срок цикла, участвуешь, по окончании забираешь обратно с дельтой по заранее фиксированным правилам смарт-контракта. Без ручного управления, всё on-chain и проверяемо. Важно: модель честная и не бесконечная — правила известны заранее. Сейчас пред-старт, впускаем первых.",
];
const META = [
  {
    type: "good",
    label: "крипто/Web3 review, EN — грань: смарт-контракт/прозрачность",
    channel_context: "DeFi/Web3 review channel",
    subject: "saw your web3 coverage",
    why: "Грань tech-прозрачность; концовка: вопрос с выбором канала + контакты столбиком.",
    end: END_EN,
  },
  {
    type: "good",
    label: "пассивный доход, RU — грань: партнёрская программа",
    channel_context: "канал про пассивный доход",
    subject: "про твой контент о пассивном доходе",
    why: "Грань рефералка; концовка с выбором канала.",
    end: END_RU,
  },
  {
    type: "good",
    label: "комьюнити/мотивация, EN — грань: манифест/DAO",
    channel_context: "community / mindset channel",
    subject: "your take on community",
    why: "Грань манифест/DAO; концовка с выбором канала.",
    end: END_EN,
  },
  {
    type: "good",
    label: "инвестиции/трейдинг, RU — грань: Smart Cycle + честные ожидания",
    channel_context: "канал с разборами для инвесторов",
    subject: "про твои разборы для инвесторов",
    why: "Грань Smart Cycle; концовка с выбором канала.",
    end: END_RU,
  },
];
const samples = META.map((m, i) => ({
  type: m.type,
  label: m.label,
  channel_context: m.channel_context,
  subject: m.subject,
  body: BODIES[i] + m.end,
  why: m.why,
}));
const sampleStr = JSON.stringify(samples);
JSON.parse(sampleStr);

db.prepare(
  "UPDATE projects SET system_prompt = ?, sample_pitches = ?, updated_at = ? WHERE id = 2",
).run(newSystem, sampleStr, new Date().toISOString());
console.log(
  `OK: system_prompt ${proj.system_prompt.length}→${newSystem.length}, sample_pitches обновлены (валидный JSON).`,
);
