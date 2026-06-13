/**
 * scripts/calibrate-analysis.js — калибровочный прогон движка channel-analysis на ~5 каналах.
 * ФАЗА 1: ТОЛЬКО ЧТЕНИЕ. channelId тянутся read-only (SELECT) из прод-БД, в БД ничего не пишется.
 *
 * Запуск (на сервере, где есть ключи и node_modules):
 *   cd /var/www/yt-parser && set -a && . .env && set +a && \
 *   NODE_PATH=/var/www/yt-parser/node_modules \
 *   node _ca-dev/calibrate-analysis.js [путь_к_db] [channelId ...]
 *
 * Если channelId не переданы — скрипт сам выберет микс из 5 (живые + подозрительные)
 * по соотношению avg_views/subscribers из таблицы leads.
 */
const path = require("path");
const Database = require("better-sqlite3");
const { analyzeChannel, _config } = require("./channel-analysis");

const DB_PATH =
  process.argv[2] && process.argv[2].endsWith(".db")
    ? process.argv[2]
    : "/var/www/yt-parser/data/ws-cmp5aou0h0005l5b26ldwn59c.db";
const explicitIds = process.argv
  .slice(2)
  .filter((a) => /^UC[\w-]{20,}$/.test(a));

function pickMix(db, n = 5) {
  const rows = db
    .prepare(
      `SELECT channel_id, channel_name, subscribers, avg_views, engagement_rate
         FROM leads
        WHERE channel_id LIKE 'UC%' AND subscribers > 5000
        ORDER BY subscribers DESC`,
    )
    .all();
  if (rows.length <= n) return rows;
  // прокси «подозрительности»: avg_views / subscribers (низкое = мёртвая аудитория)
  const withRatio = rows.map((r) => ({
    ...r,
    vs: r.subscribers > 0 ? (r.avg_views || 0) / r.subscribers : 0,
  }));
  const byVs = [...withRatio].sort((a, b) => a.vs - b.vs);
  const pick = [];
  const seen = new Set();
  const add = (r) => {
    if (r && !seen.has(r.channel_id)) {
      seen.add(r.channel_id);
      pick.push(r);
    }
  };
  add(byVs[0]); // самый «мёртвый» по просмотрам
  add(byVs[1]); // второй подозрительный
  add(byVs[byVs.length - 1]); // самый «живой»
  add(byVs[byVs.length - 2]); // второй живой
  add(byVs[Math.floor(byVs.length / 2)]); // медианный
  for (const r of withRatio) {
    if (pick.length >= n) break;
    add(r);
  }
  return pick.slice(0, n);
}

const COL = {
  reset: "\x1b[0m",
  g: "\x1b[32m",
  y: "\x1b[33m",
  r: "\x1b[31m",
  dim: "\x1b[2m",
};
const vColor = (v) => (v === "green" ? COL.g : v === "yellow" ? COL.y : COL.r);
const fnum = (n) => (n == null ? "?" : Number(n).toLocaleString("en-US"));

(async () => {
  console.log("═".repeat(70));
  console.log(
    "КАЛИБРОВКА channel-analysis — ФАЗА 1 (read-only, без записи в БД)",
  );
  console.log(
    `Конфиг: видео=${_config.N_VIDEOS}, видео-для-комментов=${_config.N_COMMENT_VIDEOS}, комментов/видео=${_config.N_COMMENTS}`,
  );
  console.log(
    `Модели: скан=${_config.SCAN_MODEL}, вердикт=${_config.VERDICT_MODEL}`,
  );
  console.log("═".repeat(70));

  const db = new Database(DB_PATH, { readonly: true });
  let targets;
  if (explicitIds.length) {
    targets = explicitIds.map((id) => {
      const r = db
        .prepare(
          "SELECT channel_id, channel_name, subscribers, avg_views FROM leads WHERE channel_id = ?",
        )
        .get(id);
      return (
        r || { channel_id: id, channel_name: "(нет в БД)", subscribers: null }
      );
    });
  } else {
    targets = pickMix(db, 5);
  }
  db.close();

  console.log(`\nВыбрано каналов: ${targets.length}`);
  targets.forEach((t, i) =>
    console.log(
      `  ${i + 1}. ${t.channel_name} — ${fnum(t.subscribers)} подп. (БД avg_views=${fnum(t.avg_views)}) [${t.channel_id}]`,
    ),
  );

  const results = [];
  let totalUnits = 0;
  let totalIn = 0;
  let totalOut = 0;

  for (const t of targets) {
    process.stdout.write(`\n▶ Анализ: ${t.channel_name} … `);
    const res = await analyzeChannel(t.channel_id);
    if (res.error) {
      console.log(`ОШИБКА: ${res.error}`);
      results.push({ t, res });
      continue;
    }
    const u = res.aiUsage;
    totalUnits += res.apiUnits || 0;
    totalIn += (u.scan.in || 0) + (u.verdict.in || 0);
    totalOut += (u.scan.out || 0) + (u.verdict.out || 0);
    console.log(
      `${vColor(res.verdict)}${res.verdict.toUpperCase()}${COL.reset} / ${res.score} · API=${res.apiUnits}ю · ${res.tookMs}ms`,
    );
    results.push({ t, res });
    await new Promise((r) => setTimeout(r, 500)); // пейсинг
  }

  // ── Отчёт-таблица ──
  console.log("\n\n" + "═".repeat(70));
  console.log("ОТЧЁТ ПО КАНАЛАМ");
  console.log("═".repeat(70));
  for (const { t, res } of results) {
    console.log(`\n${"─".repeat(70)}`);
    if (res.error) {
      console.log(`❌ ${t.channel_name} [${t.channel_id}] → ${res.error}`);
      continue;
    }
    const m = res.metrics;
    const f = m.flags;
    const fl = (x) => `${vColor(x.flag)}${x.flag}${COL.reset}`;
    console.log(
      `${vColor(res.verdict)}● ${res.channelName}${COL.reset}  →  ${vColor(res.verdict)}${res.verdict.toUpperCase()}${COL.reset} (${res.recommendation}) · балл ${res.score}/100`,
    );
    console.log(
      `  подписчиков: ${fnum(m.subs)} · страна: ${m.country || "?"} · возраст: ${m.age_days ?? "?"} дн · видео: ${m.videos_checked}`,
    );
    console.log(
      `  avg просмотры: ${fnum(m.avg_views)} (медиана ${fnum(m.median_views)})`,
    );
    console.log(
      `  views/subs: ${m.views_subs_pct}% ${fl(f.views_subs)} · likes/views: ${m.like_view_pct}% ${fl(f.like_view)} · comments/views: ${m.comment_view_pct}% ${fl(f.comment_view)}`,
    );
    console.log(
      `  разброс просмотров CV: ${m.view_cv} ${fl(f.view_cv)} · прирост: ${f.growth.value ?? "?"}/день ${fl(f.growth)}`,
    );
    console.log(
      `  живость комментов: ${m.comment_authenticity}/100 (накрутка ~${m.comment_bot_share ?? "?"}%) · проверено ${fnum(m.comments_checked)} комм. с ${m.comment_videos} видео`,
    );
    if (m.comment_note)
      console.log(`  ${COL.dim}коммент-заметка: ${m.comment_note}${COL.reset}`);
    console.log(
      `  ${COL.dim}API: ${res.apiUnits} юнитов · AI: ${res.aiUsage.scan.in + res.aiUsage.verdict.in}in/${res.aiUsage.scan.out + res.aiUsage.verdict.out}out токенов${COL.reset}`,
    );
    console.log(`  ОБОСНОВАНИЕ: ${res.reasoning}`);
    if (res.collectErrors && res.collectErrors.length)
      console.log(
        `  ${COL.dim}примечания сбора: ${res.collectErrors.length} (часть видео без комментов)${COL.reset}`,
      );
  }

  console.log("\n" + "═".repeat(70));
  console.log(
    `ИТОГО: ${results.filter((x) => !x.res.error).length} каналов · API ${totalUnits} юнитов (≈${Math.round(totalUnits / Math.max(1, results.length))}/канал) · AI ${totalIn}in/${totalOut}out токенов`,
  );
  console.log("═".repeat(70));
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
