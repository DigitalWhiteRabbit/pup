#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Разовый идемпотентный бэкафилл тегов и привязок канал→тег из
 * pre-migration SQLite-бэкапа в прод-Postgres (через штатный prisma-store,
 * чтобы попасть в правильные M2M-связи — отдельной таблицы channel_tags в
 * Postgres НЕТ, привязка живёт в MktLead.tagId).
 *
 * Источник:  tags(id,name,color,created_at) + channel_tags(channel_id,tag_id,updated_at)
 * Назначение: MktTag(workspaceId) + MktLead.tagId (через setChannelTag)
 *
 * Запуск (вручную, на проде, с прод DATABASE_URL в окружении):
 *   node tools/yt-parser/scripts/restore-tags.js --db <backup.db> --ws <wsId>            # dry-run
 *   node tools/yt-parser/scripts/restore-tags.js --db <backup.db> --ws <wsId> --apply    # запись
 *
 * НИЧЕГО не деплоит, в main не пушит, миграции Prisma не трогает.
 */

const Database = require("better-sqlite3");
const store = require("../db/prisma-store");
const { PrismaClient } = require("../db/generated/prisma");

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const APPLY = process.argv.includes("--apply");
const WS = argVal("--ws", "cmp5aou0h0005l5b26ldwn59c");
const DB_PATH = argVal("--db", null);

// Сверка (имя → ожидаемый цвет) — печатается как контроль, не как фильтр.
const EXPECTED = {
  СНГ: "#ef4444",
  "В рассылку": "#f59e0b",
  СКАМ: "#10b981",
  Мусор: "#3b82f6",
  Paid: "#8b5cf6",
};

const prisma = new PrismaClient();

async function main() {
  if (!DB_PATH) throw new Error("Укажи --db <path к backup.db>");
  console.log(`\n=== restore-tags ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log(`ws=${WS}\nbackup=${DB_PATH}\n`);

  // ── 1. Читаем бэкап (read-only) ──────────────────────────────────────────
  const sqlite = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const srcTags = sqlite
    .prepare("SELECT id, name, color, created_at FROM tags")
    .all();
  const srcLinks = sqlite
    .prepare("SELECT channel_id, tag_id, updated_at FROM channel_tags")
    .all();
  sqlite.close();
  console.log(
    `[backup] tags=${srcTags.length}  channel_tags=${srcLinks.length}`,
  );

  // Сверка тегов с эталоном
  for (const t of srcTags) {
    const exp = EXPECTED[t.name];
    const mark = !exp
      ? "??(нет в эталоне)"
      : exp === t.color
        ? "ok"
        : `MISMATCH ожид.${exp}`;
    console.log(`[backup tag] id=${t.id} "${t.name}" ${t.color} — ${mark}`);
  }

  // ── 2. Теги: oldTagId → newTagId (идемпотентно по имени) ─────────────────
  const existingTags = await store.listTags(WS);
  const byName = new Map(existingTags.map((t) => [t.name, t]));
  console.log(`\n[tags] в ws уже есть: ${existingTags.length}`);
  const idMap = new Map();
  let tagsCreated = 0;
  for (const st of srcTags) {
    let cur = byName.get(st.name);
    if (cur) {
      console.log(`  exists  "${st.name}" → ${cur.id}`);
    } else if (APPLY) {
      cur = await store.createTag(WS, st.name, st.color);
      tagsCreated++;
      console.log(`  CREATED "${st.name}" ${st.color} → ${cur.id}`);
    } else {
      console.log(`  WOULD-CREATE "${st.name}" ${st.color}`);
      cur = { id: `DRY:${st.id}` };
    }
    idMap.set(String(st.id), cur.id);
  }

  // ── 3. Привязки: setChannelTag по каналам, где есть лид ───────────────────
  // Набор каналов с лидом в этом ws — для точного отчёта в обоих режимах.
  const leadRows = await prisma.mktLead.findMany({
    where: { workspaceId: WS },
    select: { channelId: true },
  });
  const leadChannels = new Set(leadRows.map((r) => r.channelId));

  // Уже привязанные каналы — пропускаем (идемпотентность).
  const existingLinks = await store.listChannelTags(WS);
  const alreadyLinked = new Set(existingLinks.map((l) => l.channel_id));
  console.log(
    `\n[links] лидов в ws=${leadChannels.size}  уже привязано=${existingLinks.length}`,
  );

  let linked = 0;
  let skippedExisting = 0;
  let skippedUnknownTag = 0;
  const unmatched = []; // канал из бэкапа без лида в ws

  for (const link of srcLinks) {
    const ch = link.channel_id;
    const newTagId = idMap.get(String(link.tag_id));
    if (!newTagId) {
      skippedUnknownTag++;
      console.log(`  SKIP channel=${ch} — неизвестный tag_id=${link.tag_id}`);
      continue;
    }
    if (alreadyLinked.has(ch)) {
      skippedExisting++;
      continue;
    }
    if (!leadChannels.has(ch)) {
      unmatched.push(ch);
      continue;
    }
    if (APPLY) {
      const res = await store.setChannelTag(WS, ch, newTagId);
      if (res.count > 0) {
        linked++;
      } else {
        // подстраховка: лид исчез между чтением и записью
        unmatched.push(ch);
      }
    } else {
      linked++; // в dry-run считаем как "будет привязано"
    }
  }

  console.log(`\n── ИТОГ (${APPLY ? "APPLY" : "DRY-RUN"}) ──`);
  console.log(
    `теги: ${APPLY ? `создано ${tagsCreated}` : "к созданию"} (всего в маппинге ${idMap.size})`,
  );
  console.log(
    `привязки: ${APPLY ? "привязано" : "будет привязано"}=${linked}  уже было=${skippedExisting}  неизвестный тег=${skippedUnknownTag}  НЕ привязано (нет лида)=${unmatched.length}`,
  );
  if (unmatched.length) {
    console.log(`\n[не привязано] ${unmatched.length} каналов без лида в ws:`);
    for (const ch of unmatched) console.log(`  ${ch}`);
  }

  // ── 4. Верификация (после apply) ─────────────────────────────────────────
  if (APPLY) {
    const finalTags = await store.listTags(WS);
    const finalLinks = await store.listChannelTags(WS);
    const expectedLinks =
      srcLinks.length - unmatched.length - skippedUnknownTag;
    console.log(`\n── ВЕРИФИКАЦИЯ ──`);
    console.log(`listTags(ws) = ${finalTags.length}  (ожидаем 5)`);
    console.log(
      `listChannelTags(ws) = ${finalLinks.length}  (ожидаем ${srcLinks.length} − ${unmatched.length} не-привязано − ${skippedUnknownTag} неизв.тег = ${expectedLinks})`,
    );
    console.log(`tags OK: ${finalTags.length === 5}`);
    console.log(`links OK: ${finalLinks.length >= expectedLinks}`);
  } else {
    console.log(`\n(dry-run — в БД ничего не записано; запусти с --apply)`);
  }
}

main()
  .catch((e) => {
    console.error("ОШИБКА:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
