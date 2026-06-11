/**
 * services/channel-analysis.js — движок «глубокого анализа канала» (кнопка «Анализ»).
 * ТЗ: _docs/TZ-channel-deep-analysis.md. ФАЗА 1: движок + калибровка (без UI / прод-записи / деплоя).
 *
 * analyzeChannel(channelId, opts?) -> {
 *   channelId, channelName,
 *   verdict: 'green'|'yellow'|'red',
 *   recommendation: 'ads'|'project_intro'|'skip',
 *   score: 0-100,
 *   reasoning: string,            // обоснование с конкретными цифрами
 *   metrics: {...},               // см. §4 ТЗ
 *   apiUnits: number,             // расход YouTube Data API на канал
 *   aiUsage: { scan:{in,out}, verdict:{in,out} },
 *   error?: string
 * }
 *
 * ENV (лимиты глубины — §3 ТЗ, дефолты ниже):
 *   YOUTUBE_API_KEY / YT_API_KEY  — ключ YouTube Data API
 *   ANTHROPIC_API_KEY             — ключ Claude
 *   CA_VIDEOS              (25)   — сколько последних видео тянуть (20-30)
 *   CA_COMMENT_VIDEOS     (10)   — с какого числа свежих видео брать комменты (8-12)
 *   CA_COMMENTS_PER_VIDEO (100)  — топ комментов на видео (max 100)
 *   CA_SCAN_MODEL    (CLAUDE_MODEL_SUMMARY | claude-haiku-4-5)   — модель AI-скана комментов (дефолт: haiku)
 *   CA_VERDICT_MODEL (claude-sonnet-4-6)                        — модель синтеза вердикта (дефолт: sonnet)
 */
const { google } = require("googleapis");
const Anthropic = require("@anthropic-ai/sdk");

const YT_KEY = process.env.YT_API_KEY || process.env.YOUTUBE_API_KEY;
const AI_KEY = process.env.ANTHROPIC_API_KEY;
const N_VIDEOS = parseInt(process.env.CA_VIDEOS || "25", 10);
const N_COMMENT_VIDEOS = parseInt(process.env.CA_COMMENT_VIDEOS || "10", 10);
const N_COMMENTS = Math.min(
  parseInt(process.env.CA_COMMENTS_PER_VIDEO || "100", 10),
  100,
);
const SCAN_MODEL =
  process.env.CA_SCAN_MODEL ||
  process.env.CLAUDE_MODEL_SUMMARY ||
  "claude-haiku-4-5";
// Sonnet по умолчанию для вердикта — лучше справляется с граничными кейсами
const VERDICT_MODEL = process.env.CA_VERDICT_MODEL || "claude-sonnet-4-6";

function ytClient() {
  if (!YT_KEY) throw new Error("YOUTUBE_API_KEY/YT_API_KEY не задан");
  return google.youtube({ version: "v3", auth: YT_KEY });
}
let _ai = null;
function aiClient() {
  if (!AI_KEY) throw new Error("ANTHROPIC_API_KEY не задан");
  if (!_ai) _ai = new Anthropic({ apiKey: AI_KEY, maxRetries: 3 });
  return _ai;
}

// ─── статистика ──────────────────────────────────────────────────
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stddev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const pct = (n, d) => (d > 0 ? (n / d) * 100 : 0);
const round = (x, p = 2) => {
  const f = 10 ** p;
  return Math.round(x * f) / f;
};

// ═════════════════════ Этап 1: сбор (YouTube Data API) ════════════
async function collect(channelId) {
  const yt = ytClient();
  let units = 0;
  const errors = [];

  // канал — 1 юнит
  const chRes = await yt.channels.list({
    part: "snippet,statistics,brandingSettings",
    id: channelId,
  });
  units++;
  const ch = chRes.data.items?.[0];
  if (!ch) throw new Error("канал не найден по channelId");
  const channel = {
    id: channelId,
    name: ch.snippet?.title || "",
    country: ch.snippet?.country || "",
    createdAt: ch.snippet?.publishedAt || null,
    subs: parseInt(ch.statistics?.subscriberCount || "0", 10),
    totalViews: parseInt(ch.statistics?.viewCount || "0", 10),
    videoCount: parseInt(ch.statistics?.videoCount || "0", 10),
    hiddenSubs: !!ch.statistics?.hiddenSubscriberCount,
    about: (
      ch.brandingSettings?.channel?.description ||
      ch.snippet?.description ||
      ""
    ).slice(0, 500),
  };

  // последние видео — playlistItems (1 юнит) + videos.list (1 юнит)
  const uploadsId = "UU" + channelId.slice(2);
  let vidIds = [];
  try {
    const plRes = await yt.playlistItems.list({
      part: "snippet",
      playlistId: uploadsId,
      maxResults: Math.min(N_VIDEOS, 50),
    });
    units++;
    vidIds = (plRes.data.items || [])
      .map((i) => i.snippet?.resourceId?.videoId)
      .filter(Boolean)
      .slice(0, N_VIDEOS);
  } catch (e) {
    errors.push(`uploads: ${e.message}`);
  }

  let videos = [];
  if (vidIds.length) {
    const vRes = await yt.videos.list({
      part: "snippet,statistics,contentDetails",
      id: vidIds.join(","),
    });
    units++;
    videos = (vRes.data.items || []).map((v) => ({
      id: v.id,
      title: v.snippet?.title || "",
      publishedAt: v.snippet?.publishedAt || "",
      views: parseInt(v.statistics?.viewCount || "0", 10),
      likes: parseInt(v.statistics?.likeCount || "0", 10),
      comments: parseInt(v.statistics?.commentCount || "0", 10),
      duration: v.contentDetails?.duration || "",
    }));
  }

  // комменты с N_COMMENT_VIDEOS свежих видео — 1 юнит/видео
  const commentSets = [];
  for (const v of videos.slice(0, N_COMMENT_VIDEOS)) {
    try {
      const cRes = await yt.commentThreads.list({
        videoId: v.id,
        part: "snippet",
        maxResults: N_COMMENTS,
        order: "relevance",
        textFormat: "plainText",
      });
      units++;
      const comments = (cRes.data.items || []).map((it) => {
        const s = it.snippet?.topLevelComment?.snippet || {};
        return {
          author: (s.authorDisplayName || "").slice(0, 80),
          text: (s.textDisplay || "").slice(0, 400),
          likes: s.likeCount || 0,
          replies: it.snippet?.totalReplyCount || 0,
        };
      });
      commentSets.push({ videoId: v.id, title: v.title, comments });
    } catch (e) {
      // комменты могут быть выключены — это нормально
      errors.push(`comments ${v.id}: ${e.message}`);
      commentSets.push({
        videoId: v.id,
        title: v.title,
        comments: [],
        disabled: true,
      });
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  return { channel, videos, commentSets, units, errors };
}

// ═════════════════════ Этап 2: эвристики ══════════════════════════
// Пороги НАЧАЛЬНЫЕ — калибруются (§8 ТЗ). flag: value>=g→green, >=y→yellow, иначе red.
function heuristics(channel, videos) {
  const views = videos.map((v) => v.views);
  const avgViews = mean(views);
  const medViews = median(views);
  const totViews = views.reduce((s, x) => s + x, 0);
  const totLikes = videos.reduce((s, v) => s + v.likes, 0);
  const totComments = videos.reduce((s, v) => s + v.comments, 0);
  const cv = avgViews > 0 ? stddev(views) / avgViews : 0;
  const viewsSubsPct = pct(avgViews, channel.subs);
  const likeViewPct = pct(totLikes, totViews);
  const commentViewPct = pct(totComments, totViews);
  const ageDays = channel.createdAt
    ? Math.max(
        1,
        Math.round((Date.now() - new Date(channel.createdAt)) / 86400000),
      )
    : null;
  const subsPerDay = ageDays ? channel.subs / ageDays : null;

  const f = (val, g, y) => (val >= g ? "green" : val >= y ? "yellow" : "red");
  const flags = {
    // мёртвая аудитория при низком отношении просмотров к подписчикам
    views_subs: {
      value: round(viewsSubsPct),
      flag: f(viewsSubsPct, 8, 2),
      note: "avg просмотры, % от подписчиков",
    },
    // органика лайков ~1-5%; <0.5% при больших просмотрах = накрутка просмотров
    like_view: {
      value: round(likeViewPct),
      flag: f(likeViewPct, 1.5, 0.5),
      note: "лайки/просмотры, %",
    },
    // комменты ~околонуля при высоких просмотрах = подозрительно
    comment_view: {
      value: round(commentViewPct, 3),
      flag: f(commentViewPct, 0.1, 0.03),
      note: "комменты/просмотры, %",
    },
    // слишком ровные просмотры (низкий CV) + высокие = бот-флаг
    view_cv: {
      value: round(cv),
      flag: cv >= 0.5 ? "green" : cv >= 0.25 ? "yellow" : "red",
      note: "разброс просмотров (коэф. вариации); низкий+ровный = подозрительно",
    },
  };
  // рост vs возраст — мягкий сигнал (без истории — только текущий темп)
  let growthFlag = "green";
  let growthNote = "";
  if (subsPerDay != null) {
    growthNote = `~${Math.round(subsPerDay)} подп/день за ${ageDays} дн`;
    if (subsPerDay > 2000 && viewsSubsPct < 3) growthFlag = "red";
    else if (subsPerDay > 1000 && viewsSubsPct < 5) growthFlag = "yellow";
  }
  flags.growth = {
    value: subsPerDay != null ? Math.round(subsPerDay) : null,
    flag: growthFlag,
    note: growthNote,
  };

  // «Одно вирусное, остальное мёртвое»: медиана сильно ниже среднего при высоком CV
  const medAvgRatio = avgViews > 0 ? medViews / avgViews : 1;
  flags.viral_outlier = {
    value: round(medAvgRatio),
    flag:
      cv >= 1.0 && medAvgRatio < 0.3
        ? "red"
        : cv >= 0.6 && medAvgRatio < 0.5
          ? "yellow"
          : "green",
    note: "медиана/среднее просмотров; низкое+высокий CV = одно вирусное, остальное мёртвое",
  };

  return {
    subs: channel.subs,
    age_days: ageDays,
    country: channel.country,
    videos_checked: videos.length,
    avg_views: Math.round(avgViews),
    median_views: Math.round(medViews),
    median_avg_ratio: round(medAvgRatio),
    view_cv: round(cv),
    views_subs_pct: round(viewsSubsPct),
    like_view_pct: round(likeViewPct),
    comment_view_pct: round(commentViewPct, 3),
    subs_per_day: subsPerDay != null ? Math.round(subsPerDay) : null,
    flags,
  };
}

// ═════════════════════ Этап 3: AI-скан комментов (Haiku) ══════════
async function scanComments(channel, commentSets) {
  const ai = aiClient();
  const perVid = Math.max(5, Math.floor(120 / Math.max(1, commentSets.length)));
  const sample = [];
  for (const cs of commentSets) {
    for (const c of cs.comments.slice(0, perVid)) {
      sample.push(
        `[♥${c.likes}/↩${c.replies}] ${c.author}: ${c.text.replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }
  }
  const totalComments = commentSets.reduce(
    (s, cs) => s + cs.comments.length,
    0,
  );
  const withComments = commentSets.filter(
    (cs) => cs.comments.length > 0,
  ).length;
  if (sample.length === 0) {
    return {
      authenticity: 0,
      bot_share: null,
      note: "Комментарии отсутствуют или выключены на проверенных видео",
      comment_summary: "Комментарии недоступны — проверить вручную.",
      comment_examples: [],
      total_comments: 0,
      videos_with_comments: 0,
      samples: 0,
      few_data: true,
      usage: { in: 0, out: 0 },
    };
  }
  const sys =
    "Ты — аналитик аутентичности аудитории YouTube. Оцени, насколько комментарии под видео ЖИВЫЕ и органические, а не накрученные. " +
    "Признаки накрутки: генерик-фразы («nice video», «great», «❤️»), спам эмодзи, повторяющиеся однотипные комменты, офтоп, иностранный спам не по теме канала, ноль лайков и обсуждения. " +
    "Признаки живости: предметные комментарии по теме, вопросы, дискуссия, лайки на комментах, ответы (↩). Верни СТРОГО JSON без пояснений вокруг.";
  const user = `Канал: ${channel.name}
Тематика (из описания): ${channel.about.slice(0, 160) || "?"}
Выборка комментариев (${sample.length} шт. с ${withComments} видео; формат [♥лайки/↩ответы] автор: текст):

${sample.join("\n")}

Верни СТРОГО JSON:
{
  "authenticity": <0-100, насколько комменты живые/органические>,
  "bot_share": <0-100, оценка доли накрученных/мусорных>,
  "note": "<1-2 предложения с конкретикой: что видно в комментах>",
  "comment_summary": "<3-4 предложения своими словами: о чём говорят люди, какой тон, что характерно — конкретно по этому каналу>",
  "comment_examples": [
    {"text": "<точная цитата из выборки, до 150 символов>", "author": "<имя автора>", "likes": <число лайков>, "tag": "<good если живой/содержательный, bad если спам/накрутка/мусор>"}
  ]
}
В comment_examples включи 3-5 самых показательных комментариев — и хорошие примеры (живые, по теме), и плохие (спам, боты). Только реальные цитаты из выборки выше.`;
  const resp = await ai.messages.create({
    model: SCAN_MODEL,
    max_tokens: 900,
    temperature: 0.2,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  const txt = resp.content.find((b) => b.type === "text")?.text || "";
  let p = {};
  try {
    p = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    /* ignore */
  }
  return {
    authenticity: Math.max(0, Math.min(100, Math.round(p.authenticity ?? 0))),
    bot_share:
      p.bot_share == null
        ? null
        : Math.max(0, Math.min(100, Math.round(p.bot_share))),
    note: (p.note || "").slice(0, 300),
    comment_summary: (p.comment_summary || "").slice(0, 500),
    comment_examples: Array.isArray(p.comment_examples)
      ? p.comment_examples.slice(0, 5).map((e) => ({
          text: String(e.text || "").slice(0, 200),
          author: String(e.author || "").slice(0, 60),
          likes: Math.max(0, parseInt(e.likes || 0, 10)),
          tag: ["good", "bad"].includes(e.tag) ? e.tag : "good",
        }))
      : [],
    total_comments: totalComments,
    videos_with_comments: withComments,
    samples: sample.length,
    few_data: totalComments < 20,
    usage: {
      in: resp.usage?.input_tokens || 0,
      out: resp.usage?.output_tokens || 0,
    },
  };
}

// ═════════════════════ Этап 4: синтез вердикта ════════════════════
async function synthesize(channel, metrics, commentScan, opts = {}) {
  const ai = aiClient();
  const f = metrics.flags;
  const { project } = opts;

  // Блок контекста проекта для project_fit
  let projectBlock = "";
  if (
    project &&
    (project.name || project.value_prop_short || project.ideal_channel_profile)
  ) {
    let samplePitch = "";
    if (project.sample_pitches) {
      try {
        const pp = JSON.parse(project.sample_pitches);
        if (Array.isArray(pp) && pp.length > 0) {
          const first = String(pp[0] || "")
            .trim()
            .slice(0, 250);
          if (first) samplePitch = `\n- Пример питча: ${first}`;
        }
      } catch {
        /* ignore */
      }
    }
    projectBlock =
      `\nПРОЕКТ/КАМПАНИЯ (для оценки совпадения с каналом):` +
      `\n- Название: ${project.name || "?"}` +
      `\n- УТП: ${project.value_prop_short || "?"}` +
      `\n- Идеальный профиль канала: ${project.ideal_channel_profile || "?"}` +
      samplePitch;
  }

  const sys =
    "Ты — старший аналитик инфлюенс-маркетинга. На входе детерминированные метрики канала и AI-оценка живости комментариев. " +
    "Дай ИТОГОВЫЙ вердикт по блогеру для холодного аутрича, опираясь на КОНКРЕТНЫЕ цифры. Три тира:\n" +
    "- green / ads: здоровый канал, живая вовлечённая аудитория → писать по рекламе;\n" +
    "- yellow / project_intro: спорно (часть метрик слабая, но не мёртвый) → рассказать о проекте без оплаты, быстро досмотреть вручную;\n" +
    "- red / skip: явная накрутка или мёртвая аудитория → пропустить.\n" +
    "Вердикт = ассистивный пре-фильтр, не приговор. Верни СТРОГО JSON без пояснений.";

  const fewDataWarning = commentScan.few_data
    ? `\n⚠ МАЛО ДАННЫХ: всего ${commentScan.total_comments ?? 0} комментов (< 20) — при сомнениях выбирай yellow, не red.`
    : "";

  const user =
    `КАНАЛ: ${channel.name} | подписчиков: ${channel.subs} | страна: ${channel.country || "?"} | возраст: ${metrics.age_days ?? "?"} дн | видео проверено: ${metrics.videos_checked}\n` +
    `\nМЕТРИКИ (детерминированно):` +
    `\n- avg просмотры: ${metrics.avg_views} (медиана ${metrics.median_views}) → ${metrics.views_subs_pct}% от подписчиков [${f.views_subs.flag}]` +
    `\n- медиана/среднее просмотров: ${metrics.median_avg_ratio ?? "?"} [${f.viral_outlier?.flag ?? "?"}] (низкое+высокий CV = одно вирусное видео, остальные мёртвые)` +
    `\n- лайки/просмотры: ${metrics.like_view_pct}% [${f.like_view.flag}] (органика обычно 1-5%)` +
    `\n- комменты/просмотры: ${metrics.comment_view_pct}% [${f.comment_view.flag}]` +
    `\n- разброс просмотров (CV): ${metrics.view_cv} [${f.view_cv.flag}] (низкий+ровный = подозрительно)` +
    `\n- прирост: ${f.growth.value ?? "?"} подп/день [${f.growth.flag}] ${f.growth.note ? "(" + f.growth.note + ")" : ""}` +
    `\n\nAI-СКАН КОММЕНТОВ:` +
    `\n- живость/органика: ${commentScan.authenticity}/100; оценка доли накрутки: ${commentScan.bot_share ?? "?"}%` +
    `\n- заметка: ${commentScan.note || "—"}` +
    `\n- проверено: ${commentScan.total_comments ?? 0} комментов с ${commentScan.videos_with_comments ?? 0} видео${fewDataWarning}` +
    projectBlock +
    `\n\nВерни СТРОГО JSON:
{
  "verdict": "green|yellow|red",
  "recommendation": "ads|project_intro|skip",
  "score": <0-100 здоровье канала>,
  "reasoning": "<2-4 строки с КОНКРЕТНЫМИ цифрами, почему такой вердикт>",
  "bottom_line": "<ОДНА строка итога простым языком: что канал из себя представляет и стоит ли работать>",
  "strengths": ["<сильная сторона 1>", "<2>", "<3 при наличии>"],
  "red_flags": ["<флаг 1>", "<2>", "<3 при наличии>"],
  "metrics_explained": [
    {"label": "<название метрики>", "value": "<значение>", "norm": "<норма для здорового канала>", "meaning": "<что это значит для данного канала простым языком>"}
  ],
  "confidence": "high|medium|low",
  "confidence_note": "<почему: мало данных → low с пояснением, всё проверено → high>",
  "project_fit": {"match": "yes|partial|no", "note": "<почему ниша/аудитория/гео совпадает или нет>", "how_to_approach": "<конкретный совет как заходить с питчем>"}
}
В metrics_explained включи 4-6 ключевых метрик с нормами и человеческим объяснением.
Если данных о проекте нет — в project_fit.match ставь "partial", note и how_to_approach — общие советы.`;

  const resp = await ai.messages.create({
    model: VERDICT_MODEL,
    max_tokens: 1500,
    temperature: 0.2,
    system: sys,
    messages: [{ role: "user", content: user }],
  });
  const txt = resp.content.find((b) => b.type === "text")?.text || "";
  let p = {};
  try {
    p = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    /* ignore */
  }
  let verdict = ["green", "yellow", "red"].includes(p.verdict)
    ? p.verdict
    : "yellow";
  const recMap = { green: "ads", yellow: "project_intro", red: "skip" };
  let recommendation = ["ads", "project_intro", "skip"].includes(
    p.recommendation,
  )
    ? p.recommendation
    : recMap[verdict];
  // согласованность verdict ↔ recommendation (verdict — ведущий)
  recommendation = recMap[verdict];
  const score = Math.max(0, Math.min(100, Math.round(p.score ?? 50)));

  const safeStrArr = (v) =>
    Array.isArray(v) ? v.slice(0, 6).map((s) => String(s).slice(0, 200)) : [];
  const safeMetricsExplained = Array.isArray(p.metrics_explained)
    ? p.metrics_explained.slice(0, 8).map((m) => ({
        label: String(m.label || "").slice(0, 60),
        value: String(m.value || "").slice(0, 40),
        norm: String(m.norm || "").slice(0, 80),
        meaning: String(m.meaning || "").slice(0, 200),
      }))
    : [];
  const safeFit =
    p.project_fit && typeof p.project_fit === "object"
      ? {
          match: ["yes", "partial", "no"].includes(p.project_fit.match)
            ? p.project_fit.match
            : "partial",
          note: String(p.project_fit.note || "").slice(0, 300),
          how_to_approach: String(p.project_fit.how_to_approach || "").slice(
            0,
            300,
          ),
        }
      : null;

  return {
    verdict,
    recommendation,
    score,
    reasoning: (p.reasoning || "").slice(0, 600),
    bottom_line: (p.bottom_line || "").slice(0, 250),
    strengths: safeStrArr(p.strengths),
    red_flags: safeStrArr(p.red_flags),
    metrics_explained: safeMetricsExplained,
    confidence: ["high", "medium", "low"].includes(p.confidence)
      ? p.confidence
      : "medium",
    confidence_note: (p.confidence_note || "").slice(0, 200),
    project_fit: safeFit,
    usage: {
      in: resp.usage?.input_tokens || 0,
      out: resp.usage?.output_tokens || 0,
    },
  };
}

// ═════════════════════ Главная ════════════════════════════════════
async function analyzeChannel(channelId, opts = {}) {
  const t0 = Date.now();
  if (!channelId || !/^UC[\w-]{20,}$/.test(channelId)) {
    return { error: `невалидный channelId: ${channelId}`, channelId };
  }
  try {
    const { channel, videos, commentSets, units, errors } =
      await collect(channelId);
    if (!videos.length) {
      return {
        error: "нет видео для анализа",
        channelId,
        channelName: channel.name,
        metrics: { subs: channel.subs },
        apiUnits: units,
      };
    }
    const metrics = heuristics(channel, videos);
    const commentScan = await scanComments(channel, commentSets);
    const verdict = await synthesize(channel, metrics, commentScan, {
      project: opts.project || null,
    });

    // Guard: если вердикт RED, но данных по комментариям мало (< 20) и эвристики не красные
    // → понижаем до yellow, чтобы не отсеивать каналы без комментариев.
    if (verdict.verdict === "red" && commentScan.few_data) {
      const f = metrics.flags;
      const hardRedSignals = [
        "views_subs",
        "like_view",
        "comment_view",
        "growth",
      ].filter((k) => f[k]?.flag === "red");
      if (hardRedSignals.length === 0) {
        verdict.verdict = "yellow";
        verdict.recommendation = "project_intro";
        verdict.reasoning =
          `[мало данных по комментариям — ${commentScan.total_comments ?? 0} шт., вердикт снижен до yellow] ` +
          verdict.reasoning;
        verdict.score = Math.min(verdict.score + 20, 65);
      }
    }

    metrics.comment_authenticity = commentScan.authenticity;
    metrics.comment_bot_share = commentScan.bot_share;
    metrics.comment_note = commentScan.note;
    metrics.comment_summary = commentScan.comment_summary;
    metrics.comment_examples = commentScan.comment_examples;
    metrics.comments_checked = commentScan.total_comments;
    metrics.comment_videos = commentScan.videos_with_comments;
    // расширенные поля синтеза
    metrics.bottom_line = verdict.bottom_line;
    metrics.strengths = verdict.strengths;
    metrics.red_flags = verdict.red_flags;
    metrics.metrics_explained = verdict.metrics_explained;
    metrics.confidence = verdict.confidence;
    metrics.confidence_note = verdict.confidence_note;
    metrics.project_fit = verdict.project_fit;

    const out = {
      channelId,
      channelName: channel.name,
      verdict: verdict.verdict,
      recommendation: verdict.recommendation,
      score: verdict.score,
      reasoning: verdict.reasoning,
      metrics,
      apiUnits: units,
      aiUsage: { scan: commentScan.usage, verdict: verdict.usage },
      collectErrors: errors,
      tookMs: Date.now() - t0,
    };
    console.log(
      `[channel-analysis] ${channel.name}: ${verdict.verdict}/${verdict.score} | API=${units} юнитов | AI=${commentScan.usage.in + verdict.usage.in}in/${commentScan.usage.out + verdict.usage.out}out`,
    );
    return out;
  } catch (e) {
    return { error: e.message, channelId };
  }
}

module.exports = {
  analyzeChannel,
  // экспорт внутренних этапов — для тестов/калибровки
  _collect: collect,
  _heuristics: heuristics,
  _config: {
    N_VIDEOS,
    N_COMMENT_VIDEOS,
    N_COMMENTS,
    SCAN_MODEL,
    VERDICT_MODEL,
  },
};
