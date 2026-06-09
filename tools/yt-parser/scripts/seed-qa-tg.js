#!/usr/bin/env node
/**
 * seed-qa-tg.js — идемпотентный сидер для ВИЗУАЛЬНОГО QA Фазы 2 (TG-мультиканал).
 *
 * Сидирует в ОТДЕЛЬНЫЙ workspace (по умолчанию "qa-tg"), реальные данные не трогает.
 * TG-аккаунты живут в DEFAULT-БД (так устроен services/telegram-outreach.js),
 * поэтому 3 QA-аккаунта создаются там — но помечены префиксом "QA:" и при повторном
 * запуске пересоздаются (идемпотентно).
 *
 * Запуск:   node scripts/seed-qa-tg.js [workspaceId]
 * Откат:    node scripts/seed-qa-tg.js --clean [workspaceId]
 *
 * После старта сервера online-аккаунт надо пометить «готовым» в пуле сервера:
 *   curl -X POST "<base>/api/telegram/accounts/<onlineId>/qa-ready?workspace=qa-tg"
 * (qa-ready работает только при DRY_RUN=true).
 */
require("dotenv").config();
const dbm = require("../db/database");
const { localDateKey } = require("../utils/dates");

const WS =
  process.argv.find(
    (a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1],
  ) || "qa-tg";
const CLEAN = process.argv.includes("--clean");

const now = new Date().toISOString();
const todayKey = localDateKey();

const ws = dbm.getDb(WS); // QA workspace (лиды/диалоги)
const def = dbm.getDb("default"); // tg_account живёт здесь

const QA_LABEL_PREFIX = "QA:";
const QA_CHANNEL_IDS = ["QA_A", "QA_B", "QA_C", "QA_D"];

// ─── Очистка прошлого QA-прогона (идемпотентность) ─────────────────
function cleanLeads() {
  const leads = ws.db
    .prepare(
      `SELECT id FROM leads WHERE channel_id IN (${QA_CHANNEL_IDS.map(() => "?").join(",")})`,
    )
    .all(...QA_CHANNEL_IDS);
  const tx = ws.db.transaction(() => {
    for (const l of leads) {
      const ds = ws.db
        .prepare("SELECT id FROM dialogues WHERE lead_id = ?")
        .all(l.id);
      for (const d of ds)
        ws.db.prepare("DELETE FROM messages WHERE dialogue_id = ?").run(d.id);
      ws.db.prepare("DELETE FROM dialogues WHERE lead_id = ?").run(l.id);
      ws.db.prepare("DELETE FROM pending_replies WHERE lead_id = ?").run(l.id);
      ws.db.prepare("DELETE FROM lead_emails WHERE lead_id = ?").run(l.id);
      ws.db.prepare("DELETE FROM leads WHERE id = ?").run(l.id);
    }
  });
  tx();
  return leads.length;
}

function cleanAccounts() {
  const r = def.db
    .prepare(`DELETE FROM tg_account WHERE label LIKE '${QA_LABEL_PREFIX}%'`)
    .run();
  return r.changes;
}

function cleanAll() {
  const nl = cleanLeads();
  const na = cleanAccounts();
  console.log(
    `[clean] removed ${nl} QA leads (ws=${WS}) + ${na} QA accounts (default)`,
  );
}

// ─── Хелперы создания ──────────────────────────────────────────────
function ensureActiveProject() {
  let p = ws.stmts.getActiveProject.get();
  if (p) return p;
  ws.db
    .prepare(
      `INSERT INTO projects (name, description, language, is_active, created_at, updated_at)
       VALUES ('QA Campaign', 'QA-кампания для визуального теста', 'ru', 1, ?, ?)`,
    )
    .run(now, now);
  return ws.stmts.getActiveProject.get();
}

function mkLead({ channel_id, name, email, telegram }) {
  ws.stmts.insertLead.run({
    channel_id,
    channel_name: name,
    channel_url: "https://youtube.com/@" + channel_id.toLowerCase(),
    thumbnail: "",
    country: "US",
    subscribers: 50000,
    avg_views: 8000,
    engagement_rate: 4.2,
    email: email || "",
    telegram: telegram || "",
    whatsapp: "",
    raw_contacts: JSON.stringify({
      email: email || "",
      telegram: telegram || "",
    }),
    keyword: "qa",
    created_at: now,
    updated_at: now,
  });
  const lead = ws.db
    .prepare("SELECT * FROM leads WHERE channel_id = ?")
    .get(channel_id);
  ws.db
    .prepare(
      "UPDATE leads SET lead_status = 'ready', dialogue_stage = 'not_contacted' WHERE id = ?",
    )
    .run(lead.id);
  if (email) {
    try {
      dbm.syncLeadEmails(WS, lead.id, email);
    } catch {}
  }
  return lead.id;
}

function mkAccount(fields) {
  const r = def.stmts.insertTgAccount.run({
    label: fields.label,
    phone: fields.phone || null,
    api_id: null,
    api_hash: null,
    proxy_type: fields.proxy_type || "socks5",
    proxy_host: fields.proxy_host || null,
    proxy_port: fields.proxy_port || null,
    proxy_user: fields.proxy_user || null,
    proxy_pass: fields.proxy_pass || null,
    status: fields.status || "active",
    daily_cap: fields.daily_cap != null ? fields.daily_cap : 50,
    created_at: now,
    updated_at: now,
  });
  return r.lastInsertRowid;
}

// ─── Main ──────────────────────────────────────────────────────────
if (CLEAN) {
  cleanAll();
  process.exit(0);
}

// Всегда чистим перед сидом → повторный запуск даёт тот же результат.
cleanAll();

const project = ensureActiveProject();

// Лид A: только email → email зелёный, TG красный
const A = mkLead({
  channel_id: "QA_A",
  name: "QA-A · только Email",
  email: "qa.a@example.com",
});
// Лид B: только telegram → TG зелёный (нужен живой аккаунт), email красный
const B = mkLead({
  channel_id: "QA_B",
  name: "QA-B · только Telegram",
  telegram: "qa_b_blogger",
});
// Лид C: email + telegram → оба зелёные
const C = mkLead({
  channel_id: "QA_C",
  name: "QA-C · Email + Telegram",
  email: "qa.c@example.com",
  telegram: "qa_c_blogger",
});
// Лид D: email + telegram + существующие диалоги по обоим каналам
const D = mkLead({
  channel_id: "QA_D",
  name: "QA-D · диалоги в обоих каналах",
  email: "qa.d@example.com",
  telegram: "qa_d_blogger",
});

// ─── 3 TG-аккаунта (статусы) ───────────────────────────────────────
const accOnline = mkAccount({
  label: QA_LABEL_PREFIX + " online",
  phone: "+19990000001",
  proxy_host: "10.0.0.1",
  proxy_port: 1080,
  proxy_user: "u",
  proxy_pass: "p",
  status: "active",
  daily_cap: 50,
});
// online: прогрев (день1 = 5) + ненулевой sent_today → виден прогресс лимита
def.db
  .prepare(
    `UPDATE tg_account SET first_used_at = ?, sent_today = 2, sent_today_date = ? WHERE id = ?`,
  )
  .run(now, todayKey, accOnline);

const accFlood = mkAccount({
  label: QA_LABEL_PREFIX + " flood",
  phone: "+19990000002",
  proxy_host: "10.0.0.2",
  proxy_port: 1080,
  status: "active",
  daily_cap: 50,
});
def.db
  .prepare(
    `UPDATE tg_account SET flood_until = ?, sent_today = 5, sent_today_date = ? WHERE id = ?`,
  )
  .run(Date.now() + 3600 * 1000, todayKey, accFlood);

const accDisabled = mkAccount({
  label: QA_LABEL_PREFIX + " disabled",
  phone: "+19990000003",
  proxy_host: "10.0.0.3",
  proxy_port: 1080,
  status: "disabled",
  daily_cap: 30,
});

// ─── Диалоги лида D (email + telegram с in/out) ─────────────────────
function addDialogueWithMsgs(leadId, channel, accountId) {
  const ext =
    channel === "telegram" ? "qa_chat_" + leadId : "qa_thread_" + leadId;
  const dr = ws.stmts.insertDialogue.run(leadId, channel, ext, now);
  const dlgId = dr.lastInsertRowid;
  if (accountId != null) ws.stmts.setDialogueAccount.run(accountId, dlgId);
  const outMeta =
    channel === "email"
      ? { subject: "Идея коллаборации", recipient: "qa.d@example.com" }
      : { chat_id: ext, account_id: accountId };
  ws.stmts.insertMessage.run({
    dialogue_id: dlgId,
    direction: "out",
    sender: "agent",
    content:
      channel === "email"
        ? "Привет! Видели ваш контент — есть идея для интеграции. Подробности внутри."
        : "Привет! Пишем по поводу возможной интеграции — удобно обсудить тут?",
    metadata: JSON.stringify(outMeta),
    created_at: now,
    tracking_id: null,
  });
  ws.stmts.insertMessage.run({
    dialogue_id: dlgId,
    direction: "in",
    sender: "blogger",
    content:
      channel === "email"
        ? "Здравствуйте! Интересно, расскажите подробнее про условия."
        : "Привет, да, давайте обсудим. Какой бюджет?",
    metadata: JSON.stringify(
      channel === "telegram"
        ? { username: "qa_d_blogger", chat_id: ext, account_id: accountId }
        : { from: "qa.d@example.com" },
    ),
    created_at: now,
    tracking_id: null,
  });
  ws.stmts.incrementDialogueMsgCount.run(dlgId);
  ws.stmts.incrementDialogueMsgCount.run(dlgId);
  return dlgId;
}

const dEmail = addDialogueWithMsgs(D, "email", null);
const dTg = addDialogueWithMsgs(D, "telegram", accOnline);
ws.db
  .prepare(
    "UPDATE leads SET lead_status = 'in_work', dialogue_stage = 'replied' WHERE id = ?",
  )
  .run(D);

console.log("─".repeat(60));
console.log(`QA seed готов. workspace = "${WS}"`);
console.log("Лиды:");
console.log(`  A (только email)        id=${A}`);
console.log(`  B (только telegram)     id=${B}`);
console.log(`  C (email + telegram)    id=${C}`);
console.log(
  `  D (диалоги обоих кан.)  id=${D}  [email dlg=${dEmail}, tg dlg=${dTg} → acc#${accOnline}]`,
);
console.log("TG-аккаунты (default БД):");
console.log(
  `  online   id=${accOnline}  (sent_today=2/cap, прогрев день1, нужен qa-ready)`,
);
console.log(`  flood    id=${accFlood}   (flood_until +1ч)`);
console.log(`  disabled id=${accDisabled}`);
console.log("─".repeat(60));
console.log(`Чтобы online-аккаунт стал «online» в UI, после старта сервера:`);
console.log(
  `  curl -X POST "<base>/api/telegram/accounts/${accOnline}/qa-ready?workspace=${WS}"`,
);
console.log(`Project: ${project.name} (id=${project.id}, active)`);
console.log(`Откат: node scripts/seed-qa-tg.js --clean ${WS}`);

// Экспорт id для смоук-скрипта
console.log(
  "JSON " +
    JSON.stringify({
      ws: WS,
      leads: { A, B, C, D },
      accounts: { online: accOnline, flood: accFlood, disabled: accDisabled },
      dialogues: { email: dEmail, telegram: dTg },
    }),
);
