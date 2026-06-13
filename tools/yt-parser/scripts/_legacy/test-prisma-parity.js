/**
 * test-prisma-parity.js — паритет нового prisma-store против старого database.js
 * на QA-данных (SQLite data/ws-qa-tg.db ↔ Postgres workspace qa-tg).
 *
 * Сравнивает списочные запросы: количество, порядок, бизнес-поля
 * (id исключён: int vs cuid). Exit ≠ 0 при любом расхождении.
 *
 * Запуск: node db/test-prisma-parity.js
 */
require("dotenv").config();
const path = require("path");
const Database = require("better-sqlite3");
const store = require("./prisma-store");
const { resolveWorkspaceId } = require("./workspace-map");

const WS_KEY = "qa-tg";
const SQLITE_FILE = path.join(__dirname, "..", "data", `ws-${WS_KEY}.db`);

let failures = 0;
const diffs = [];

function fail(label, detail) {
  failures++;
  diffs.push(`${label}: ${detail}`);
  return "✗";
}

function cmpRowField(label, i, field, a, b) {
  // null/undefined считаем эквивалентными (better-sqlite3 отдаёт null)
  const av = a == null ? null : a;
  const bv = b == null ? null : b;
  if (av !== bv) {
    return fail(
      `${label}[${i}].${field}`,
      `SQLite=${JSON.stringify(av)} Prisma=${JSON.stringify(bv)}`,
    );
  }
  return "✓";
}

/** Сравнить два списка по количеству, порядку и набору бизнес-полей. */
function compareLists(label, sqRows, prRows, fields) {
  let mark = "✓";
  if (sqRows.length !== prRows.length) {
    mark = fail(
      `${label}.count`,
      `SQLite=${sqRows.length} Prisma=${prRows.length}`,
    );
  } else {
    for (let i = 0; i < sqRows.length; i++) {
      for (const f of fields) {
        if (cmpRowField(label, i, f, sqRows[i][f], prRows[i][f]) === "✗")
          mark = "✗";
      }
    }
  }
  console.log(
    `${label.padEnd(28)} ${String(sqRows.length).padStart(6)} ${String(prRows.length).padStart(7)}  ${mark}`,
  );
}

async function main() {
  const wsId = resolveWorkspaceId(WS_KEY);
  if (!wsId) throw new Error(`Ключ "${WS_KEY}" не разрезолвился`);

  const sq = new Database(SQLITE_FILE, { readonly: true, fileMustExist: true });

  // Старый слой: те же prepared statements, что в database.js (точные копии SQL)
  const sqListLeads = sq.prepare(`
    SELECT * FROM leads
    WHERE (@status IS NULL OR lead_status = @status)
      AND (@stage IS NULL OR dialogue_stage = @stage)
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `);
  const sqCountLeads = sq.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN lead_status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN lead_status='ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN lead_status='in_work' THEN 1 ELSE 0 END) AS in_work,
      SUM(CASE WHEN lead_status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN lead_status='rejected' THEN 1 ELSE 0 END) AS rejected
    FROM leads
  `);
  const sqListAllDialogues = sq.prepare(`
    SELECT d.*, l.channel_name, l.country, l.subscribers, l.lead_status, l.dialogue_stage, l.notes,
           (SELECT content FROM messages WHERE dialogue_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message,
           (SELECT created_at FROM messages WHERE dialogue_id = d.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
           (SELECT COUNT(*) FROM messages WHERE dialogue_id = d.id) AS message_count,
           (SELECT opened_at FROM messages WHERE dialogue_id = d.id AND direction = 'out' ORDER BY created_at DESC LIMIT 1) AS last_out_opened_at,
           (SELECT open_count FROM messages WHERE dialogue_id = d.id AND direction = 'out' ORDER BY created_at DESC LIMIT 1) AS last_out_open_count
    FROM dialogues d
    JOIN leads l ON l.id = d.lead_id
    ORDER BY last_message_at DESC NULLS LAST, d.created_at DESC
  `);
  const sqMessagesByLead = sq.prepare(`
    SELECT m.* FROM messages m
    JOIN dialogues d ON d.id = m.dialogue_id
    WHERE d.lead_id = ?
    ORDER BY m.created_at ASC, m.id ASC
  `);
  const sqListProjects = sq.prepare(
    `SELECT * FROM projects ORDER BY created_at DESC`,
  );
  const sqActiveProject = sq.prepare(
    `SELECT * FROM projects WHERE is_active = 1 LIMIT 1`,
  );
  const sqListPendingReplies = sq.prepare(`
    SELECT pr.*, l.channel_name, l.country, l.subscribers, l.channel_url
    FROM pending_replies pr
    LEFT JOIN leads l ON l.id = pr.lead_id
    WHERE (@status IS NULL OR pr.status = @status)
    ORDER BY pr.created_at DESC
    LIMIT @limit OFFSET @offset
  `);
  const sqListPendingDeals = sq.prepare(`
    SELECT d.*, l.channel_name, l.subscribers, l.country
    FROM deals d JOIN leads l ON l.id = d.lead_id
    WHERE d.admin_decision IS NULL
    ORDER BY d.created_at DESC
  `);

  console.log(
    `\n━━━ Паритет prisma-store ↔ database.js (qa-tg ↔ ${wsId}) ━━━\n`,
  );
  console.log(
    `${"запрос".padEnd(28)} ${"SQLite".padStart(6)} ${"Prisma".padStart(7)}  ok`,
  );

  // 1. listLeads (без фильтров)
  const args = { status: null, stage: null, limit: 100, offset: 0 };
  const sqLeads = sqListLeads.all(args);
  const prLeads = await store.listLeads(wsId, args);
  compareLists("listLeads", sqLeads, prLeads, [
    "channel_id",
    "channel_name",
    "lead_status",
    "dialogue_stage",
    "country",
    "subscribers",
    "email",
    "telegram",
    "keyword",
    "tg_draft",
    "notes",
    "created_at",
  ]);

  // 1b. listLeads с фильтром по статусу
  const argsReady = { status: "ready", stage: null, limit: 100, offset: 0 };
  compareLists(
    "listLeads(status=ready)",
    sqListLeads.all(argsReady),
    await store.listLeads(wsId, argsReady),
    ["channel_id", "lead_status"],
  );

  // 2. countLeads
  const sqCounts = sqCountLeads.get();
  const prCounts = await store.countLeads(wsId);
  let cMark = "✓";
  for (const k of [
    "total",
    "pending",
    "ready",
    "in_work",
    "done",
    "rejected",
  ]) {
    const a = sqCounts[k] ?? 0;
    const b = prCounts[k] ?? 0;
    if (a !== b) cMark = fail(`countLeads.${k}`, `SQLite=${a} Prisma=${b}`);
  }
  console.log(
    `${"countLeads".padEnd(28)} ${String(sqCounts.total).padStart(6)} ${String(prCounts.total).padStart(7)}  ${cMark}`,
  );

  // 3. getLead — точечно, по первому листовому лиду (мост: channel_id)
  const sqFirst = sqLeads[0];
  const prFirst = prLeads.find((x) => x.channel_id === sqFirst.channel_id);
  let gMark = prFirst
    ? "✓"
    : fail("getLead", "лид по channel_id не найден в Prisma");
  if (prFirst) {
    const viaGet = await store.getLead(wsId, prFirst.id);
    for (const f of [
      "channel_id",
      "channel_name",
      "lead_status",
      "dialogue_stage",
    ]) {
      if (cmpRowField("getLead", 0, f, sqFirst[f], viaGet[f]) === "✗")
        gMark = "✗";
    }
  }
  console.log(
    `${"getLead(по первому)".padEnd(28)} ${"1".padStart(6)} ${"1".padStart(7)}  ${gMark}`,
  );

  // 4. listAllDialogues
  const sqDialogues = sqListAllDialogues.all();
  const prDialogues = await store.listAllDialogues(wsId);
  compareLists("listAllDialogues", sqDialogues, prDialogues, [
    "channel",
    "external_thread_id",
    "account_id",
    "channel_name",
    "country",
    "subscribers",
    "lead_status",
    "dialogue_stage",
    "last_message",
    "last_message_at",
    "message_count",
    "last_out_opened_at",
    "last_out_open_count",
    "created_at",
  ]);

  // 5. listMessagesByLead — для каждого лида с диалогами (мост по channel_id)
  const sqLeadsWithDialogues = sq
    .prepare(
      `SELECT DISTINCT l.* FROM leads l JOIN dialogues d ON d.lead_id = l.id ORDER BY l.id`,
    )
    .all();
  for (const sqLead of sqLeadsWithDialogues) {
    const prLead = prLeads.find((x) => x.channel_id === sqLead.channel_id);
    if (!prLead) {
      fail(`messages(${sqLead.channel_id})`, "лид не найден в Prisma");
      continue;
    }
    compareLists(
      `messages(${sqLead.channel_id})`,
      sqMessagesByLead.all(sqLead.id),
      await store.listMessagesByLead(wsId, prLead.id),
      [
        "content",
        "direction",
        "sender",
        "content_ru",
        "tracking_id",
        "open_count",
        "created_at",
      ],
    );
  }

  // 6. projects: список + активный
  const sqProjects = sqListProjects.all();
  const prProjects = await store.listProjects(wsId);
  compareLists("listProjects", sqProjects, prProjects, [
    "name",
    "is_active",
    "description",
    "language",
    "system_prompt",
    "reply_delay_min",
    "reply_delay_max",
  ]);
  const sqActive = sqActiveProject.get() || null;
  const prActive = await store.getActiveProject(wsId);
  const aMark =
    (sqActive ? sqActive.name : null) === (prActive ? prActive.name : null) &&
    (sqActive ? sqActive.is_active : null) ===
      (prActive ? prActive.is_active : null)
      ? "✓"
      : fail(
          "getActiveProject",
          `SQLite=${sqActive && sqActive.name} Prisma=${prActive && prActive.name}`,
        );
  console.log(
    `${"getActiveProject".padEnd(28)} ${String(sqActive ? 1 : 0).padStart(6)} ${String(prActive ? 1 : 0).padStart(7)}  ${aMark}`,
  );

  // 7. pending_replies
  const prArgs = { status: null, limit: 100, offset: 0 };
  compareLists(
    "listPendingReplies",
    sqListPendingReplies.all(prArgs),
    await store.listPendingReplies(wsId, prArgs),
    [
      "channel",
      "recipient",
      "subject",
      "body",
      "status",
      "channel_name",
      "send_after",
      "created_at",
    ],
  );

  // 8. deals (pending)
  compareLists(
    "listPendingDeals",
    sqListPendingDeals.all(),
    await store.listPendingDeals(wsId),
    [
      "proposed_price",
      "admin_decision",
      "agent_summary",
      "channel_name",
      "created_at",
    ],
  );

  sq.close();

  if (failures === 0) {
    console.log(
      `\n━━━ ПАРИТЕТ ✓ — prisma-store отдаёт то же, что database.js ━━━\n`,
    );
  } else {
    console.log(`\n━━━ ПАРИТЕТ ✗ — расхождений: ${failures} ━━━`);
    for (const d of diffs) console.log(`  ✗ ${d}`);
    console.log("");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exitCode = 1;
  })
  .finally(() => store.prisma.$disconnect());
