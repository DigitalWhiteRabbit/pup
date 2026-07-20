const crypto = require("crypto");
// Шаг 4b-2: воркер полностью на prisma-store (Postgres). SQLite (db/database.js)
// больше не используется здесь.
const store = require("../db/prisma-store");
const { resolveWorkspaceId, WORKSPACE_MAP } = require("../db/workspace-map");
const ai = require("./ai");

// Резолв ключа/идентификатора воркспейса → PUP cuid (принимаем и ключ, и cuid).
function resolveWsCuid(workspaceKeyOrCuid) {
  if (!workspaceKeyOrCuid) return null;
  return (
    resolveWorkspaceId(workspaceKeyOrCuid) ||
    (Object.values(WORKSPACE_MAP).includes(workspaceKeyOrCuid)
      ? workspaceKeyOrCuid
      : null)
  );
}
const email = require("./email");
const tg = require("./telegram-outreach");
const adminBot = require("./admin-bot");
const { localDateKey } = require("../utils/dates");

const DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";

// ─── Email open tracking helpers ───────────────────────────────────

function generateTrackingId() {
  return crypto.randomBytes(16).toString("hex");
}

function buildTrackingPixelUrl(workspaceId, trackingId) {
  const baseUrl = (
    process.env.BASE_URL ||
    process.env.PUBLIC_DOMAIN ||
    ""
  ).replace(/\/$/, "");
  if (!baseUrl) return null;
  return `${baseUrl}/yt-parser/api/track/open/${workspaceId}_${trackingId}.png`;
}

// ─── State ──────────────────────────────────────────────────────────

let workerState = {
  running: false,
  outreachInterval: null,
  inboxInterval: null,
  decisionsInterval: null,
  lastTick: null,
  lastError: null,
  stats: { sent: 0, replied: 0, errors: 0, deals: 0 },
};

// Module-level guard против реентранса inbox/replies handler.
let isProcessingReplies = false;
let isProcessingApproved = false;
let isProcessingOutreach = false;

const OUTREACH_TICK_MS = 30_000;
const INBOX_TICK_MS = 60_000;
const SEND_DELAY_MIN = 30_000; // (оставлено для справки)
const SEND_DELAY_MAX = 120_000;

// Locks & limits
const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 min
const LOCK_DURATION_ERR_MS = 10 * 60 * 1000; // 10 min при ошибке
const MAX_REPLIES_PER_TICK = parseInt(
  process.env.MAX_REPLIES_PER_TICK || "3",
  10,
);
const LOOP_MESSAGE_LIMIT = parseInt(process.env.LOOP_MESSAGE_LIMIT || "20", 10);
const DAILY_CAP_EMAIL = parseInt(process.env.DAILY_CAP_EMAIL || "200", 10);
const DAILY_CAP_TG = parseInt(process.env.DAILY_CAP_TG || "50", 10);

// ─── Logging ────────────────────────────────────────────────────────

const logBuffer = [];
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
}
function getLogs() {
  return logBuffer.slice();
}

// ─── Helpers ────────────────────────────────────────────────────────

function safeJsonParse(str, fallback = {}) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function todayKey() {
  return localDateKey();
}

// Инкремент дневного счётчика отправок через store (ws-scoped).
async function bumpDaily(wsId, channel) {
  await store.upsertDailyCounters(wsId, {
    date: todayKey(),
    sent_email: channel === "email" ? 1 : 0,
    sent_tg: channel === "telegram" ? 1 : 0,
    ai_input_tokens: 0,
    ai_output_tokens: 0,
    ai_cache_read: 0,
    ai_cache_creation: 0,
  });
}

// Email normalization & parsing
function parseEmailList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[;,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
function parseTelegramHandle(raw) {
  if (!raw) return null;
  return String(raw).split(/[;,]/)[0].trim().replace(/^@/, "").toLowerCase();
}

// ─── Multichannel helpers ───────────────────────────────────────────

// Доступность каналов у лида: email — есть адрес; telegram — есть хендл И
// есть живой TG-аккаунт под лимитом. Используется и для рассылки, и для
// подсветки кнопок пикера на фронте.
function channelAvailability(lead) {
  return {
    email: !!(lead.email && String(lead.email).trim()),
    telegram:
      !!(lead.telegram && String(lead.telegram).trim()) &&
      tg.anyReadyUnderLimit(),
  };
}

const ALL_CHANNELS = ["email", "telegram"];

function recipientFor(lead, channel) {
  return channel === "email"
    ? parseEmailList(lead.email)[0]
    : parseTelegramHandle(lead.telegram);
}

// Отправка ответа в TG ТЕМ ЖЕ аккаунтом, что ведёт диалог (dialogues.account_id).
// Если у диалога ещё нет привязки — выбираем здоровый аккаунт и фиксируем его.
async function sendTelegramBound(wsId, dialogueId, recipient, text) {
  let accountId = null;
  if (dialogueId) {
    accountId = await store.getDialogueAccountId(wsId, dialogueId);
  }
  if (accountId == null) accountId = tg.pickAccount();
  if (accountId == null)
    throw new Error("нет доступного TG-аккаунта (залогинен/под лимитом)");
  const result = await tg.sendMessageVia(accountId, recipient, text);
  if (dialogueId) {
    const cur = await store.getDialogueAccountId(wsId, dialogueId);
    if (cur == null)
      await store.setDialogueAccount(wsId, result.accountId, dialogueId);
  }
  return result;
}

// Validation: проверить что extracted_price реально упоминается в последних in-сообщениях
function validatePriceMention(history, extractedPrice) {
  if (!extractedPrice) return false;
  const lastIn = history.filter((m) => m.direction === "in").slice(-3);
  const joined = lastIn.map((m) => String(m.content || "")).join(" ");
  const numbers = (joined.match(/\d{3,}/g) || []).map((n) => parseInt(n, 10));
  // Близко если в пределах ±20%
  return numbers.some(
    (n) => Math.abs(n - extractedPrice) <= Math.max(50, extractedPrice * 0.2),
  );
}

// ─── Outreach loop ──────────────────────────────────────────────────

// Шаг 3.3c-1: петля исходящей рассылки на prisma-store. Перечисляем воркспейсы
// с активным проектом (вместо файлового скана ws-*.db) и итерируем по cuid.
async function processOutreachQueue() {
  if (!workerState.running) return;
  if (isProcessingOutreach) return;
  isProcessingOutreach = true;
  workerState.lastTick = new Date().toISOString();

  try {
    const wsIds = await store.listActiveWorkspaceIds();
    for (const wsId of wsIds) {
      try {
        await _processWorkspaceOutreach(wsId);
      } catch (e) {
        log("ERR", `Outreach ws ${wsId} failed: ${e.message}`);
        workerState.lastError = e.message;
        workerState.stats.errors++;
      }
    }
  } catch (e) {
    log("ERR", `Outreach tick failed: ${e.message}`);
    workerState.lastError = e.message;
    workerState.stats.errors++;
  } finally {
    isProcessingOutreach = false;
  }
}

// Один тик исходящей по одному воркспейсу (cuid). Всё через store.
async function _processWorkspaceOutreach(currentWsId) {
  const project = await store.getActiveProject(currentWsId);
  if (!project) return; // активный проект мог пропасть между enum и обработкой

  // Автопилот НЕ инициирует первый контакт сам: первый питч уходит ТОЛЬКО по явному
  // «Запустить» (runLeadNow/runLeadsNow). Иначе любой промоутнутый в «Лиды» лид
  // (READY+NOT_CONTACTED = «в очереди») авто-рассылался бы пачкой. Авто-режим: auto_outreach=1.
  if (!(await isAutoOutreachStore(currentWsId))) return;

  const counts = await store.getDailyCounts(currentWsId, todayKey());
  if (counts.sent_email >= DAILY_CAP_EMAIL && counts.sent_tg >= DAILY_CAP_TG) {
    log(
      "INFO",
      `[${currentWsId}] Daily cap reached (email=${counts.sent_email}/${DAILY_CAP_EMAIL}, tg=${counts.sent_tg}/${DAILY_CAP_TG})`,
    );
    return;
  }

  // Атомарный pick+lock (условный updateMany, без гонки)
  const lead = await store.claimNextOutreachLead(currentWsId, LOCK_DURATION_MS);
  if (!lead) return;

  // Привязываем учёт токенов AI к этому воркспейсу на время обработки.
  ai.setUsageWorkspace(currentWsId);
  try {
    await _processPickedLeadStore(currentWsId, lead, project, counts);
  } finally {
    ai.setUsageWorkspace(null);
  }
}

// ═══ STORE-версии email-пути (Шаг 3.3c-1) ═══════════════════════════════════
// Параллельны legacy sync-хелперам ниже (помечены TRANSIENT). Принимают wsId
// (cuid), все БД-операции — через store. Используются ТОЛЬКО петлёй исходящей.

// store-версия isReviewMode: читает review_mode из MktSetting воркспейса (Postgres),
// а не из SQLite-default (как legacy isReviewMode). Fallback на ENV.
async function isReviewModeStore(wsId) {
  try {
    const row = await store.getSetting(wsId, "review_mode");
    if (row && row.value) return row.value === "1" || row.value === "true";
  } catch {}
  return process.env.REVIEW_MODE === "true" || process.env.REVIEW_MODE === "1";
}

// Автопилот исходящей: инициировать ли ПЕРВЫЙ контакт самому (без явного «Запустить»).
// По умолчанию ВЫКЛЮЧЕН — первый питч уходит только через runLeadNow/runLeadsNow
// (кнопка «Запустить» с выбором канала). Включить: настройка auto_outreach=1 на воркспейс.
async function isAutoOutreachStore(wsId) {
  try {
    const row = await store.getSetting(wsId, "auto_outreach");
    if (row && row.value) return row.value === "1" || row.value === "true";
  } catch {}
  return (
    process.env.AUTO_OUTREACH === "true" || process.env.AUTO_OUTREACH === "1"
  );
}

// store-версия resolveChannels: доступные ∩ запрошенные − уже_отправленные − в_очереди
async function resolveChannelsStore(wsId, lead, requested) {
  const avail = channelAvailability(lead); // sync: только поля лида + tg-пул
  const available = ALL_CHANNELS.filter((c) => avail[c]);
  const want =
    Array.isArray(requested) && requested.length
      ? requested.filter((c) => available.includes(c))
      : available;
  const alreadyOut = new Set(await store.listSentChannels(wsId, lead.id));
  const selected = [];
  for (const c of want) {
    if (alreadyOut.has(c)) continue;
    if (await store.hasPendingForChannel(wsId, lead.id, c)) continue;
    selected.push(c);
  }
  return { available, want, alreadyOut, selected };
}

// store-версия queueReply (review-режим): создаёт pending_reply + нотификация админу
async function queueReplyStore(wsId, p) {
  const now = new Date().toISOString();
  const r = await store.insertPendingReply(wsId, {
    lead_id: p.lead_id,
    dialogue_id: p.dialogue_id ?? null,
    channel: p.channel,
    recipient: p.recipient,
    subject: p.subject ?? null,
    body: p.body,
    context: JSON.stringify(p.context || {}),
    created_at: now,
  });
  log(
    "INFO",
    `[review] queued pending_reply ${r.id} for lead ${p.lead_id} (${(p.context || {}).type})`,
  );
  if (adminBot.isReady() && typeof adminBot.notifyPendingReply === "function") {
    try {
      const pr = await store.getPendingReply(wsId, r.id);
      adminBot
        .notifyPendingReply(pr)
        .catch((e) => log("ERR", "notifyPendingReply: " + e.message));
    } catch {}
  }
  return r.id;
}

// store-версия отправки initial-питча по каналу. email — полный путь через store.
// telegram — реальная отправка через tg.* (легаси, не переводим в 3.3c-1),
// но персист dialogue/message — через store.
async function _sendInitialOnChannelStore(
  wsId,
  lead,
  channel,
  recipient,
  pitch,
  now,
) {
  let externalId = null;
  let metadata = { recipient };
  let trackingId = null;
  let accountId = null;

  if (channel === "telegram") accountId = tg.pickAccount();

  if (DRY_RUN) {
    log(
      "INFO",
      `[DRY_RUN] Would send ${channel} to ${recipient}${accountId != null ? ` via acc#${accountId}` : ""}\n${channel === "email" ? "Subject: " + (pitch.subject || "") + "\n" : ""}${pitch.body}`,
    );
    externalId = `dry-run-${Date.now()}`;
    metadata.dry_run = true;
    if (channel === "email") {
      metadata.subject = pitch.subject;
      metadata.resend_id = externalId;
    } else {
      metadata.tg_message_id = externalId;
      metadata.chat_id = externalId;
      if (accountId != null) metadata.account_id = accountId;
    }
  } else if (channel === "email") {
    trackingId = generateTrackingId();
    const trackingPixelUrl = buildTrackingPixelUrl(wsId, trackingId);
    const result = await email.sendEmail({
      to: recipient,
      subject: pitch.subject || "Hello",
      body: pitch.body,
      leadId: lead.id,
      trackingPixelUrl,
    });
    externalId = result.messageId;
    metadata.subject = pitch.subject;
    metadata.resend_id = result.id;
  } else if (channel === "telegram") {
    if (accountId == null)
      throw new Error("нет доступного TG-аккаунта (залогинен/под лимитом)");
    const result = await tg.sendMessageVia(accountId, recipient, pitch.body);
    externalId = result.chatId;
    metadata.tg_message_id = result.messageId;
    metadata.chat_id = result.chatId;
    metadata.account_id = result.accountId;
    accountId = result.accountId;
  }

  // Персист диалога + сообщения через store (Prisma не имеет sync-транзакции;
  // порядок insert'ов сохраняет инварианты).
  const dlg = await store.insertDialogue(
    wsId,
    lead.id,
    channel,
    externalId,
    now,
  );
  if (channel === "telegram" && accountId != null)
    await store.setDialogueAccount(wsId, accountId, dlg.id);
  await store.insertMessage(wsId, {
    dialogue_id: dlg.id,
    direction: "out",
    sender: "agent",
    content: pitch.body,
    metadata: JSON.stringify(metadata),
    resend_id: metadata.resend_id ?? null,
    created_at: now,
    tracking_id: trackingId,
  });

  await store.upsertDailyCounters(wsId, {
    date: todayKey(),
    sent_email: channel === "email" ? 1 : 0,
    sent_tg: channel === "telegram" ? 1 : 0,
    ai_input_tokens: 0,
    ai_output_tokens: 0,
    ai_cache_read: 0,
    ai_cache_creation: 0,
  });
  workerState.stats.sent++;
  log(
    "INFO",
    `Sent ${channel} to ${recipient} (lead ${lead.id})${accountId != null ? ` via acc#${accountId}` : ""}`,
  );
  return true;
}

// store-версия обработки взятого лида. Зеркало _processPickedLead, всё через store.
async function _processPickedLeadStore(
  wsId,
  lead,
  project,
  counts,
  options = {},
) {
  try {
    log("INFO", `Processing lead ${lead.id} ${lead.channel_name}`);

    // Auto-enrich (3.3c-2): computeEnrichment чистый → персист через store.
    try {
      const { computeEnrichment } = require("./enrichment");
      const updates = await computeEnrichment(lead);
      if (Object.keys(updates).length > 0) {
        const ts = new Date().toISOString();
        await store.updateLeadFields(wsId, lead.id, {
          ...updates,
          enriched_at: ts,
        });
        Object.assign(lead, updates, { enriched_at: ts });
        log(
          "INFO",
          `Lead ${lead.id} enriched: ${Object.keys(updates).join(",")}`,
        );
      }
    } catch (e) {
      log("WARN", `Enrichment failed for lead ${lead.id}: ${e.message}`);
    }

    // Auto-score after enrichment
    try {
      const scoring = require("./lead-scoring");
      const videoAnalysis = scoring.analyzeVideos
        ? scoring.analyzeVideos(lead.last_videos_json)
        : null;
      const { score, breakdown } = scoring.computeScore
        ? scoring.computeScore(
            lead,
            videoAnalysis,
            project?.ideal_channel_profile,
            project?.bad_fit_examples,
          )
        : { score: 50, breakdown: {} };
      lead.lead_score = score;
      lead.score_breakdown = JSON.stringify(breakdown);
      await store.updateLeadScoring(wsId, lead.id, {
        lead_score: score,
        score_breakdown: lead.score_breakdown,
        scored_at: new Date().toISOString(),
      });
      log("INFO", `Lead ${lead.id} scored: ${score}/100`);
    } catch (e) {
      log("WARN", `Scoring failed for lead ${lead.id}: ${e.message}`);
    }

    // Авто-сводка перед питчем
    if (!lead.content_summary) {
      try {
        const summary = await ai.generateContentSummary(lead, project, wsId);
        await store.updateLeadSummary(
          wsId,
          summary,
          new Date().toISOString(),
          lead.id,
        );
        lead.content_summary = summary;
        log("INFO", `Lead ${lead.id} content_summary auto-generated`);
      } catch (e) {
        log("WARN", `summary failed lead ${lead.id}: ${e.message}`);
      }
    }

    if (lead.opted_out) {
      log("INFO", `Lead ${lead.id} opted out — skipping`);
      await store.unlockLead(wsId, lead.id);
      return;
    }

    const { available, want, alreadyOut, selected } =
      await resolveChannelsStore(wsId, lead, options.channels);
    if (selected.length === 0) {
      log(
        "WARN",
        `Lead ${lead.id}: нечего слать — доступно=[${available}] запрошено=[${want}] уже_отправлено=[${[...alreadyOut]}]; пропуск`,
      );
      if (alreadyOut.size > 0) {
        await store.updateLeadStage(
          wsId,
          "contacted",
          new Date().toISOString(),
          lead.id,
        );
        await store.unlockLead(wsId, lead.id);
      } else {
        await store.lockLead(wsId, Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      }
      return;
    }

    // fit-gate
    let pitchAngle = null;
    try {
      const qual = await ai.qualifyLead(lead, project);
      log(
        "INFO",
        `Lead ${lead.id} fit-gate: suitable=${qual.suitable}, angle=${qual.angle}`,
      );
      pitchAngle = qual.angle || null;
    } catch (e) {
      log("WARN", `fit-gate failed for lead ${lead.id}: ${e.message}`);
    }

    let pitch;
    try {
      pitch = await ai.generateInitialPitch(
        lead,
        project,
        "email",
        pitchAngle,
        wsId,
      );
    } catch (e) {
      log("ERR", `AI generation failed for lead ${lead.id}: ${e.message}`);
      workerState.lastError = e.message;
      workerState.stats.errors++;
      await store.lockLead(wsId, Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      return;
    }
    if (!pitch.body) {
      log("ERR", `AI returned empty pitch for lead ${lead.id}`);
      await store.lockLead(wsId, Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      return;
    }

    const now = new Date().toISOString();

    // Review mode: pending_reply на каждый выбранный канал (per-ws из Postgres)
    if (await isReviewModeStore(wsId)) {
      let queued = 0;
      for (const channel of selected) {
        const recipient = recipientFor(lead, channel);
        if (!recipient) continue;
        await queueReplyStore(wsId, {
          lead_id: lead.id,
          dialogue_id: null,
          channel,
          recipient,
          subject: channel === "email" ? pitch.subject : null,
          body: pitch.body,
          context: {
            type: "initial",
            project_id: project.id,
            conversation_stage: pitch.conversation_stage || "introduction",
          },
        });
        queued++;
      }
      if (queued > 0) {
        await store.updateLeadStage(wsId, "awaiting_review", now, lead.id);
        await store.updateLeadStatus(wsId, "in_work", now, lead.id);
        await store.lockLead(wsId, Date.now() + 60 * 60 * 1000, lead.id);
      } else {
        await store.lockLead(wsId, Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      }
      return;
    }

    // Прямая отправка
    let sentAny = false;
    for (const channel of selected) {
      const recipient = recipientFor(lead, channel);
      if (!recipient) {
        log("WARN", `Lead ${lead.id} пустой recipient для ${channel}`);
        continue;
      }
      const dc = await store.getDailyCounts(wsId, todayKey());
      if (channel === "email" && dc.sent_email >= DAILY_CAP_EMAIL) {
        log("INFO", `email daily cap reached — пропуск email lead ${lead.id}`);
        continue;
      }
      if (channel === "telegram" && dc.sent_tg >= DAILY_CAP_TG) {
        log("INFO", `tg daily cap reached — пропуск tg lead ${lead.id}`);
        continue;
      }
      try {
        const ok = await _sendInitialOnChannelStore(
          wsId,
          lead,
          channel,
          recipient,
          pitch,
          now,
        );
        if (ok) sentAny = true;
      } catch (e) {
        log("ERR", `${channel} send failed for lead ${lead.id}: ${e.message}`);
        workerState.lastError = e.message;
        workerState.stats.errors++;
      }
    }

    if (sentAny) {
      const ts = new Date().toISOString();
      await store.updateLeadStage(wsId, "awaiting_reply", ts, lead.id);
      await store.updateLeadStatus(wsId, "in_work", ts, lead.id);
      await store.updateLeadProject(wsId, project.id, ts, lead.id);
      await store.unlockLead(wsId, lead.id);
    } else {
      await store.lockLead(wsId, Date.now() + LOCK_DURATION_ERR_MS, lead.id);
    }
  } catch (e) {
    log("ERR", `_processPickedLeadStore failed for ${lead.id}: ${e.message}`);
    workerState.lastError = e.message;
    workerState.stats.errors++;
    await store.lockLead(wsId, Date.now() + LOCK_DURATION_ERR_MS, lead.id);
  }
}

// Немедленная обработка конкретного лида (по кнопке «Запустить» в UI).
// channels — выбор каналов из пикера (["email","telegram"]) или null = все доступные.
// Шаг 3.3c-2: ручной запуск через store-путь (резолв ключа/cuid → cuid).
async function runLeadNow(leadId, workspaceKeyOrCuid, channels = null) {
  const wsId = resolveWsCuid(workspaceKeyOrCuid);
  if (!wsId)
    throw new Error(`workspace "${workspaceKeyOrCuid}" not mapped to Prisma`);

  const project = await store.getActiveProject(wsId);
  if (!project) throw new Error("no active project");
  const lead = await store.getLead(wsId, leadId);
  if (!lead) throw new Error("lead not found");
  if (lead.lead_status !== "ready")
    throw new Error(`lead_status is "${lead.lead_status}", expected "ready"`);

  await store.lockLead(wsId, Date.now() + LOCK_DURATION_MS, lead.id);
  const counts = await store.getDailyCounts(wsId, todayKey());
  ai.setUsageWorkspace(wsId);
  try {
    await _processPickedLeadStore(
      wsId,
      { ...lead, locked_until: Date.now() + LOCK_DURATION_MS },
      project,
      counts,
      { channels },
    );
  } finally {
    ai.setUsageWorkspace(null);
  }
}

// Последовательный запуск нескольких лидов (bulk «Запустить»): по очереди,
// без параллелизма — чтобы не было всплеска вызовов API и соблюдался daily cap.
async function runLeadsNow(leadIds, workspaceId, channels = null) {
  for (const id of leadIds || []) {
    try {
      await runLeadNow(id, workspaceId, channels);
    } catch (e) {
      log("WARN", `bulk-run lead #${id}: ${e.message}`);
    }
  }
}

// ─── Inbox loop (Шаг 3.3c-2: на store; матчинг — глобальный по Postgres) ─────

const _repliedWorkspaces = new Set();

// Обработать один распарсенный входящий email (вынесено для тестируемости —
// можно подать фейковый msg без реального IMAP).
async function _ingestIncomingEmail(msg) {
  if (email.isAutoReply(msg)) {
    log(
      "INFO",
      `Skipping auto-reply from ${msg.from} (subject: ${msg.subject})`,
    );
    if (msg.uid != null) await email.markSeen(msg.uid);
    return null;
  }

  // Глобальный матчинг по всем воркспейсам (Postgres), без файлового скана.
  const match = await store.findReplyMatch(
    msg.from,
    msg.inReplyTo,
    msg.references,
  );
  if (!match || !match.lead) {
    log("WARN", `No matching lead for email from ${msg.from}, leaving unseen`);
    return null;
  }
  const wsId = match.wsId;
  let dialogue = match.dialogue;
  const now = new Date().toISOString();

  if (!dialogue) {
    const d = await store.insertDialogue(
      wsId,
      match.lead.id,
      "email",
      msg.messageId,
      now,
    );
    dialogue = { id: d.id, lead_id: match.lead.id, channel: "email" };
  }
  await store.insertMessage(wsId, {
    dialogue_id: dialogue.id,
    direction: "in",
    sender: "blogger",
    content: msg.text,
    metadata: JSON.stringify({
      subject: msg.subject,
      from: msg.from,
      messageId: msg.messageId,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      uid: msg.uid,
    }),
    created_at: now,
    tracking_id: null,
  });
  await store.updateLeadStage(wsId, "replied", now, match.lead.id);

  if (msg.uid != null) await email.markSeen(msg.uid);
  workerState.stats.replied++;
  _repliedWorkspaces.add(wsId);
  log(
    "INFO",
    `New reply from ${msg.from} (lead ${match.lead.id}, ws: ${wsId})`,
  );
  return wsId;
}

async function processInbox() {
  if (!workerState.running) return;
  if (!process.env.RESEND_API_KEY || !process.env.IMAP_HOST) return;
  _repliedWorkspaces.clear();

  try {
    const messages = await email.fetchInbox();
    if (messages.length === 0) return;
    log("INFO", `Fetched ${messages.length} new emails`);
    for (const msg of messages) {
      try {
        await _ingestIncomingEmail(msg);
      } catch (e) {
        log("ERR", `Inbox message processing failed: ${e.message}`);
        workerState.stats.errors++;
      }
    }
  } catch (e) {
    log("ERR", `Inbox poll failed: ${e.message}`);
    workerState.lastError = e.message;
    workerState.stats.errors++;
  }

  // Генерация ответов по воркспейсам с новыми сообщениями (cuid).
  for (const wsId of _repliedWorkspaces) {
    await generatePendingReplies(wsId);
  }
}

// ─── Reply generation (with reentrancy guard + concurrency cap) ────

// Шаг 3.3c-2: генерация ответов по воркспейсу (cuid) через store.
async function generatePendingReplies(wsId) {
  if (!wsId) return;
  if (isProcessingReplies) {
    log("DEBUG", "generatePendingReplies already running, skipping");
    return;
  }
  isProcessingReplies = true;
  try {
    const leads = await store.pickLeadsWithNewReplies(wsId);
    if (leads.length === 0) return;
    const project = await store.getActiveProject(wsId);
    if (!project) return;

    ai.setUsageWorkspace(wsId);
    const queue = leads.slice(0, 50);
    for (const lead of queue) {
      try {
        await processOneLeadReply(wsId, lead, project);
      } catch (e) {
        log("ERR", `Reply generation failed for lead ${lead.id}: ${e.message}`);
        workerState.lastError = e.message;
        workerState.stats.errors++;
      }
    }
  } finally {
    ai.setUsageWorkspace(null);
    isProcessingReplies = false;
  }
}

async function processOneLeadReply(wsId, lead, project) {
  const dialogue = await store.getLatestDialogueByLead(wsId, lead.id);
  if (!dialogue) return;
  // В review-mode не плодим дубли pending_replies для одного диалога
  if (
    (await isReviewModeStore(wsId)) &&
    (await store.hasPendingForChannel(wsId, lead.id, dialogue.channel))
  )
    return;

  const history = await store.listMessagesByDialogue(wsId, dialogue.id);

  // Loop detection: если уже слишком много сообщений — просим админа
  if (history.length >= LOOP_MESSAGE_LIMIT) {
    log(
      "WARN",
      `Lead ${lead.id} hit message limit ${LOOP_MESSAGE_LIMIT} — escalating to admin`,
    );
    const now = new Date().toISOString();
    const existing = await store.getPendingConsultation(wsId, lead.id);
    if (!existing) {
      const r = await store.insertConsultation(wsId, {
        lead_id: lead.id,
        question: `Диалог достиг ${history.length} сообщений без закрытия. Прошу подключиться вручную.`,
        context: JSON.stringify(history.slice(-5)),
        created_at: now,
      });
      if (adminBot.isReady() && r.id) {
        adminBot
          .askConsultation({ id: r.id, lead_id: lead.id }, lead)
          .catch((e) => log("ERR", "Bot notify failed: " + e.message));
      }
    }
    return;
  }

  const reply = await ai.generateReply(
    lead,
    project,
    history,
    dialogue.channel,
    null,
    wsId,
  );
  const now = new Date().toISOString();

  // Flag: price_mentioned → создать deal (с валидацией)
  if (reply.flag === "price_mentioned" && reply.extracted_price) {
    if (!validatePriceMention(history, reply.extracted_price)) {
      log(
        "WARN",
        `Lead ${lead.id} extracted_price=${reply.extracted_price} not found in last in-messages, skipping deal creation`,
      );
    } else {
      log("INFO", `Lead ${lead.id} mentioned price: ${reply.extracted_price}`);
      const summary = await ai.summarizeDialogue(lead, history);
      const dealRes = await store.insertDeal(
        wsId,
        lead.id,
        project.id,
        reply.extracted_price,
        summary,
        now,
      );
      await store.updateLeadStage(wsId, "deal_pending", now, lead.id);
      workerState.stats.deals++;
      log(
        "INFO",
        `Deal ${dealRes.id} created for lead ${lead.id}, awaiting admin approval`,
      );
      // adminBot.sendDealNotification ожидает legacy-форму сделки — отдаём из store
      return;
    }
  }

  if (reply.flag === "consultation_needed" && reply.consultation_question) {
    log("INFO", `Lead ${lead.id} needs admin consultation`);
    const r = await store.insertConsultation(wsId, {
      lead_id: lead.id,
      question: reply.consultation_question,
      context: JSON.stringify(history.slice(-3)),
      created_at: now,
    });
    if (adminBot.isReady() && r.id) {
      adminBot
        .askConsultation({ id: r.id, lead_id: lead.id }, lead)
        .catch((e) => log("ERR", "Bot notify failed: " + e.message));
    }
    return;
  }

  if (reply.body) {
    // Review mode: в очередь вместо отправки
    if (await isReviewModeStore(wsId)) {
      const firstMeta = history[0] ? safeJsonParse(history[0].metadata) : {};
      const recipient =
        dialogue.channel === "email"
          ? parseEmailList(lead.email)[0]
          : parseTelegramHandle(lead.telegram);
      await queueReplyStore(wsId, {
        lead_id: lead.id,
        dialogue_id: dialogue.id,
        channel: dialogue.channel,
        recipient,
        subject: reply.subject || "Re: " + (firstMeta.subject || ""),
        body: reply.body,
        context: {
          type: "reply",
          conversation_stage: reply.conversation_stage || "negotiating",
        },
      });
      if (reply.conversation_stage) {
        const stageMap = {
          introduction: "contacted",
          qualification: "contacted",
          value_proposition: "negotiating",
          needs_analysis: "negotiating",
          solution_presentation: "negotiating",
          objection_handling: "negotiating",
          negotiation: "negotiating",
          close: "deal_pending",
          end_conversation: "lost",
        };
        const newStage = stageMap[reply.conversation_stage] || "negotiating";
        await store.updateLeadStage(
          wsId,
          newStage,
          new Date().toISOString(),
          lead.id,
        );
        log(
          "INFO",
          `Lead ${lead.id} stage: ${reply.conversation_stage} → ${newStage}`,
        );
      }
      return;
    }

    // Прямая отправка
    let metadata = {};
    let trackingId = null;
    if (dialogue.channel === "email") {
      trackingId = generateTrackingId();
      const trackingPixelUrl = buildTrackingPixelUrl(wsId, trackingId);
      const lastOut = history.filter((m) => m.direction === "out").pop();
      const replyToHeader = lastOut
        ? safeJsonParse(lastOut.metadata).resend_id
        : null;
      const firstMeta = history[0] ? safeJsonParse(history[0].metadata) : {};
      const result = await email.sendEmail({
        to: parseEmailList(lead.email)[0],
        subject: reply.subject || "Re: " + (firstMeta.subject || ""),
        body: reply.body,
        replyToHeader,
        leadId: lead.id,
        trackingPixelUrl,
      });
      metadata = { subject: reply.subject, resend_id: result.id };
    } else if (dialogue.channel === "telegram") {
      // TG-отправка остаётся через легаси sendTelegramBound (3.3c-4); персист — store.
      const tgResult = await sendTelegramBound(
        wsId,
        dialogue.id,
        parseTelegramHandle(lead.telegram),
        reply.body,
      );
      metadata = {
        tg_message_id: tgResult.messageId,
        chat_id: tgResult.chatId,
        account_id: tgResult.accountId,
      };
    }

    await store.insertMessage(wsId, {
      dialogue_id: dialogue.id,
      direction: "out",
      sender: "agent",
      content: reply.body,
      metadata: JSON.stringify(metadata),
      resend_id: metadata.resend_id ?? null,
      created_at: now,
      tracking_id: trackingId,
    });
    await store.upsertDailyCounters(wsId, {
      date: todayKey(),
      sent_email: dialogue.channel === "email" ? 1 : 0,
      sent_tg: dialogue.channel === "telegram" ? 1 : 0,
      ai_input_tokens: 0,
      ai_output_tokens: 0,
      ai_cache_read: 0,
      ai_cache_creation: 0,
    });
    await store.updateLeadStage(wsId, "negotiating", now, lead.id);
    log("INFO", `Sent ${dialogue.channel} reply to lead ${lead.id}`);
  }
}

// ─── Process decided deals (admin approved/rejected) ───────────────

// Шаг 3.3c-3: исполнение решённых сделок — per-ws через store.
async function processDecidedDeals() {
  if (!workerState.running) return;
  for (const wsId of await store.listActiveWorkspaceIds()) {
    try {
      await _processDecidedDealsForWs(wsId);
    } catch (e) {
      log("ERR", `processDecidedDeals ws ${wsId}: ${e.message}`);
      workerState.stats.errors++;
    }
  }
}

async function _processDecidedDealsForWs(wsId) {
  const decided = await store.listDecidedDealsPending(wsId);
  if (decided.length === 0) return;
  const project = await store.getActiveProject(wsId);
  if (!project) return;

  ai.setUsageWorkspace(wsId);
  try {
    for (const deal of decided) {
      try {
        const lead = await store.getLead(wsId, deal.l_id);
        const dialogue = await store.getLatestDialogueByLead(wsId, lead.id);
        if (!dialogue) continue;
        const history = await store.listMessagesByDialogue(wsId, dialogue.id);

        const adminDirective =
          deal.admin_decision === "approved"
            ? `АДМИН ОДОБРИЛ цену ${deal.proposed_price} ₽. Подтверди блогеру что согласен на эту сумму, поблагодари, спроси про следующие шаги (даты, ТЗ, оплата).`
            : `АДМИН ОТКЛОНИЛ цену ${deal.proposed_price} ₽. Вежливо предложи контр-предложение в рамках бюджета ${project.budget_min}-${project.budget_max} ₽, объясни что это максимум. Если блогер не согласится — попрощайся вежливо.`;

        const reply = await ai.generateReply(
          lead,
          project,
          history,
          dialogue.channel,
          adminDirective,
          wsId,
        );
        const now = new Date().toISOString();
        const finalStage =
          deal.admin_decision === "approved" ? "won" : "negotiating";

        // Review mode → в очередь
        if (await isReviewModeStore(wsId)) {
          if (await store.hasPendingForChannel(wsId, lead.id, dialogue.channel))
            continue;
          const recipient =
            dialogue.channel === "email"
              ? parseEmailList(lead.email)[0]
              : parseTelegramHandle(lead.telegram);
          await queueReplyStore(wsId, {
            lead_id: lead.id,
            dialogue_id: dialogue.id,
            channel: dialogue.channel,
            recipient,
            subject: reply.subject || "Re: ",
            body: reply.body,
            context: {
              type: "deal_accept",
              deal_id: deal.id,
              deal_decision: deal.admin_decision,
              next_stage: finalStage,
            },
          });
          continue;
        }

        // Прямая отправка
        let metadata = {};
        let trackingId = null;
        if (dialogue.channel === "email") {
          trackingId = generateTrackingId();
          const trackingPixelUrl = buildTrackingPixelUrl(wsId, trackingId);
          const replyToHeader = await store.getLastOutResendId(
            wsId,
            dialogue.id,
          );
          const result = await email.sendEmail({
            to: parseEmailList(lead.email)[0],
            subject: reply.subject || "Re: ",
            body: reply.body,
            replyToHeader,
            leadId: lead.id,
            trackingPixelUrl,
          });
          metadata = { subject: reply.subject, resend_id: result.id };
        } else if (dialogue.channel === "telegram") {
          // TG-отправка — легаси (3.3c-4); персист — store.
          const tgResult = await sendTelegramBound(
            wsId,
            dialogue.id,
            parseTelegramHandle(lead.telegram),
            reply.body,
          );
          metadata = {
            tg_message_id: tgResult.messageId,
            chat_id: tgResult.chatId,
            account_id: tgResult.accountId,
          };
          await bumpDaily(wsId, "telegram");
        }

        await store.insertMessage(wsId, {
          dialogue_id: dialogue.id,
          direction: "out",
          sender: "agent",
          content: reply.body,
          metadata: JSON.stringify({
            ...metadata,
            deal_decision: deal.admin_decision,
          }),
          resend_id: metadata.resend_id ?? null,
          created_at: now,
          tracking_id: trackingId,
        });
        if (dialogue.channel === "email") {
          await store.upsertDailyCounters(wsId, {
            date: todayKey(),
            sent_email: 1,
            sent_tg: 0,
            ai_input_tokens: 0,
            ai_output_tokens: 0,
            ai_cache_read: 0,
            ai_cache_creation: 0,
          });
        }
        await store.updateLeadStage(wsId, finalStage, now, lead.id);
        log(
          "INFO",
          `Deal ${deal.id} executed (${deal.admin_decision}) for lead ${lead.id}`,
        );
      } catch (e) {
        log(
          "ERR",
          `processDecidedDeals failed for deal ${deal.id}: ${e.message}`,
        );
        workerState.stats.errors++;
      }
    }
  } finally {
    ai.setUsageWorkspace(null);
  }
}

// ─── Process answered consultations (Шаг 3.3c-3: per-ws через store) ─────────

async function processAnsweredConsultations() {
  if (!workerState.running) return;
  for (const wsId of await store.listActiveWorkspaceIds()) {
    try {
      await _processAnsweredConsultationsForWs(wsId);
    } catch (e) {
      log("ERR", `processAnsweredConsultations ws ${wsId}: ${e.message}`);
    }
  }
}

async function _processAnsweredConsultationsForWs(wsId) {
  const answered = await store.listAnsweredConsultations(wsId);
  if (answered.length === 0) return;
  const project = await store.getActiveProject(wsId);
  if (!project) return;

  ai.setUsageWorkspace(wsId);
  try {
    for (const consultation of answered) {
      try {
        if (!consultation.lead_id) continue;
        const lead = await store.getLead(wsId, consultation.lead_id);
        if (!lead) continue;
        const dialogue = await store.getLatestDialogueByLead(wsId, lead.id);
        if (!dialogue) continue;
        const history = await store.listMessagesByDialogue(wsId, dialogue.id);
        const adminDirective = `ОТВЕТ АДМИНА НА ТВОЙ ВОПРОС "${consultation.question}": ${consultation.admin_response}\nИспользуй эту информацию чтобы продолжить диалог с блогером. Не упоминай что консультировался с админом.`;

        const reply = await ai.generateReply(
          lead,
          project,
          history,
          dialogue.channel,
          adminDirective,
          wsId,
        );
        const now = new Date().toISOString();

        if (await isReviewModeStore(wsId)) {
          if (await store.hasPendingForChannel(wsId, lead.id, dialogue.channel))
            continue;
          const recipient =
            dialogue.channel === "email"
              ? parseEmailList(lead.email)[0]
              : parseTelegramHandle(lead.telegram);
          await queueReplyStore(wsId, {
            lead_id: lead.id,
            dialogue_id: dialogue.id,
            channel: dialogue.channel,
            recipient,
            subject: reply.subject || "Re: ",
            body: reply.body,
            context: {
              type: "consultation_answer",
              consultation_id: consultation.id,
            },
          });
          continue;
        }

        let metadata = { consultation_id: consultation.id };
        let trackingId = null;
        if (dialogue.channel === "email") {
          trackingId = generateTrackingId();
          const trackingPixelUrl = buildTrackingPixelUrl(wsId, trackingId);
          const replyToHeader = await store.getLastOutResendId(
            wsId,
            dialogue.id,
          );
          const result = await email.sendEmail({
            to: parseEmailList(lead.email)[0],
            subject: reply.subject || "Re: ",
            body: reply.body,
            replyToHeader,
            trackingPixelUrl,
          });
          metadata.subject = reply.subject;
          metadata.resend_id = result.id;
        } else if (dialogue.channel === "telegram") {
          const tgResult = await sendTelegramBound(
            wsId,
            dialogue.id,
            parseTelegramHandle(lead.telegram),
            reply.body,
          );
          metadata.tg_message_id = tgResult.messageId;
          metadata.chat_id = tgResult.chatId;
          metadata.account_id = tgResult.accountId;
          await bumpDaily(wsId, "telegram");
        }

        await store.insertMessage(wsId, {
          dialogue_id: dialogue.id,
          direction: "out",
          sender: "agent",
          content: reply.body,
          metadata: JSON.stringify(metadata),
          resend_id: metadata.resend_id ?? null,
          created_at: now,
          tracking_id: trackingId,
        });
        if (dialogue.channel === "email") {
          await store.upsertDailyCounters(wsId, {
            date: todayKey(),
            sent_email: 1,
            sent_tg: 0,
            ai_input_tokens: 0,
            ai_output_tokens: 0,
            ai_cache_read: 0,
            ai_cache_creation: 0,
          });
        }
        log(
          "INFO",
          `Consultation ${consultation.id} processed for lead ${lead.id}`,
        );
      } catch (e) {
        log("ERR", `processAnsweredConsultations failed: ${e.message}`);
      }
    }
  } finally {
    ai.setUsageWorkspace(null);
  }
}

// ─── Process approved pending replies (Шаг 3.3c-3: store, per-ws) ──────────

// processApprovedQueue(keyOrCuid?) — если задан воркспейс, обрабатываем его;
// иначе итерируем все активные. Атомарный claim approved→sending (store, count===1).
async function processApprovedQueue(workspaceKeyOrCuid) {
  if (isProcessingApproved) return;
  isProcessingApproved = true;
  try {
    let wsIds;
    if (workspaceKeyOrCuid) {
      const cuid = resolveWsCuid(workspaceKeyOrCuid);
      wsIds = cuid ? [cuid] : [];
    } else {
      wsIds = await store.listActiveWorkspaceIds();
    }
    for (const wsId of wsIds) {
      try {
        await _processApprovedQueueForWs(wsId);
      } catch (e) {
        log("ERR", `processApprovedQueue ws ${wsId}: ${e.message}`);
        workerState.stats.errors++;
      }
    }
  } finally {
    isProcessingApproved = false;
  }
}

async function _processApprovedQueueForWs(wsId) {
  const items = await store.pickApprovedPendingReplies(
    wsId,
    MAX_REPLIES_PER_TICK,
  );
  if (items.length === 0) return;
  ai.setUsageWorkspace(wsId);
  try {
    for (const item of items) {
      // Timer check: send_after в будущем — пропускаем
      if (item.send_after && new Date(item.send_after) > new Date()) continue;
      // Атомарный claim approved→sending (только один тик возьмёт).
      const claimed = await store.claimApprovedPendingReply(wsId, item.id);
      if (!claimed) continue;
      try {
        await sendApprovedPendingReply(wsId, item);
      } catch (e) {
        log("ERR", `pending_reply ${item.id} send failed: ${e.message}`);
        try {
          await store.markPendingReplyFailed(
            wsId,
            e.message.slice(0, 500),
            item.id,
          );
        } catch {
          await store.unclaimApprovedPendingReply(wsId, item.id);
        }
        workerState.lastError = e.message;
        workerState.stats.errors++;
      }
    }
  } finally {
    ai.setUsageWorkspace(null);
  }
}

async function sendApprovedPendingReply(wsId, item) {
  const ctx = safeJsonParse(item.context);
  const body =
    item.edited_body && item.edited_body.trim() ? item.edited_body : item.body;
  const subject =
    item.edited_subject && item.edited_subject.trim()
      ? item.edited_subject
      : item.subject;
  const lead = await store.getLead(wsId, item.lead_id);
  if (!lead) throw new Error("lead not found");
  if (lead.opted_out) throw new Error("lead opted out");

  const now = new Date().toISOString();
  const daily = await store.getDailyCounts(wsId, todayKey());
  if (item.channel === "email" && daily.sent_email >= DAILY_CAP_EMAIL)
    throw new Error("daily email cap reached");
  if (item.channel === "telegram" && daily.sent_tg >= DAILY_CAP_TG)
    throw new Error("daily tg cap reached");

  // Для reply нужен resend_id последнего out для In-Reply-To
  let replyToHeader = null;
  if (item.dialogue_id && item.channel === "email") {
    replyToHeader = await store.getLastOutResendId(wsId, item.dialogue_id);
  }

  // Для TG: аккаунт-владелец диалога (легаси getDialogue — TG-домен, 3.3c-4).
  let tgAccountId = null;
  if (item.channel === "telegram") {
    if (item.dialogue_id) {
      const d = await store.getDialogue(wsId, item.dialogue_id);
      if (d && d.account_id != null) tgAccountId = d.account_id;
    }
    if (tgAccountId == null) tgAccountId = tg.pickAccount();
  }

  // Отправка
  let externalId = null;
  let sendMeta = {};
  let trackingId = null;
  if (DRY_RUN) {
    log(
      "INFO",
      `[DRY_RUN] Would send ${item.channel} to ${item.recipient}${
        item.channel === "telegram" && tgAccountId != null
          ? ` via acc#${tgAccountId}`
          : ""
      }\nSubject: ${subject || ""}\n${body}`,
    );
    externalId = `dry-run-${Date.now()}`;
    sendMeta = { subject, dry_run: true };
    if (item.channel === "email") sendMeta.resend_id = externalId;
    else if (item.channel === "telegram") {
      sendMeta.tg_message_id = externalId;
      sendMeta.chat_id = externalId;
      if (tgAccountId != null) sendMeta.account_id = tgAccountId;
    }
  } else if (item.channel === "email") {
    trackingId = generateTrackingId();
    const trackingPixelUrl = buildTrackingPixelUrl(wsId, trackingId);
    const result = await email.sendEmail({
      to: item.recipient,
      subject: subject || "Hello",
      body,
      replyToHeader,
      leadId: lead.id,
      trackingPixelUrl,
    });
    externalId = result.messageId;
    sendMeta = { subject, resend_id: result.id };
  } else if (item.channel === "telegram") {
    // TG-отправка — легаси (3.3c-4).
    if (tgAccountId == null)
      throw new Error("нет доступного TG-аккаунта (залогинен/под лимитом)");
    const result = await tg.sendMessageVia(tgAccountId, item.recipient, body);
    externalId = result.chatId;
    sendMeta = {
      tg_message_id: result.messageId,
      chat_id: result.chatId,
      account_id: result.accountId,
    };
    tgAccountId = result.accountId;
  } else {
    throw new Error("unknown channel " + item.channel);
  }

  // Post-send: зависит от типа (порядок store-операций сохраняет инварианты)
  const type = ctx.type;
  if (type === "initial") {
    const dlg = await store.insertDialogue(
      wsId,
      lead.id,
      item.channel,
      externalId,
      now,
    );
    if (item.channel === "telegram" && tgAccountId != null)
      await store.setDialogueAccount(wsId, tgAccountId, dlg.id);
    await store.insertMessage(wsId, {
      dialogue_id: dlg.id,
      direction: "out",
      sender: "agent",
      content: body,
      metadata: JSON.stringify({ ...sendMeta, pending_reply_id: item.id }),
      resend_id: sendMeta.resend_id ?? null,
      created_at: now,
      tracking_id: trackingId,
    });
    await store.updateLeadStage(wsId, "awaiting_reply", now, lead.id);
    await store.updateLeadStatus(wsId, "in_work", now, lead.id);
    if (ctx.project_id)
      await store.updateLeadProject(wsId, ctx.project_id, now, lead.id);
    await store.unlockLead(wsId, lead.id);
  } else if (
    type === "reply" ||
    type === "deal_accept" ||
    type === "consultation_answer"
  ) {
    const metaExtra = {};
    if (type === "deal_accept") metaExtra.deal_decision = ctx.deal_decision;
    if (type === "consultation_answer")
      metaExtra.consultation_id = ctx.consultation_id;
    if (item.channel === "telegram" && tgAccountId != null && item.dialogue_id)
      await store.setDialogueAccount(wsId, tgAccountId, item.dialogue_id);
    await store.insertMessage(wsId, {
      dialogue_id: item.dialogue_id,
      direction: "out",
      sender: "agent",
      content: body,
      metadata: JSON.stringify({
        ...sendMeta,
        ...metaExtra,
        pending_reply_id: item.id,
      }),
      resend_id: sendMeta.resend_id ?? null,
      created_at: now,
      tracking_id: trackingId,
    });
    if (ctx.next_stage)
      await store.updateLeadStage(wsId, ctx.next_stage, now, lead.id);
  }
  await store.markPendingReplySent(wsId, now, item.id);

  // Дневной счётчик: email — store; TG — легаси (3.3c-4).
  if (item.channel === "email") {
    await store.upsertDailyCounters(wsId, {
      date: todayKey(),
      sent_email: 1,
      sent_tg: 0,
      ai_input_tokens: 0,
      ai_output_tokens: 0,
      ai_cache_read: 0,
      ai_cache_creation: 0,
    });
  } else if (item.channel === "telegram") {
    await bumpDaily(wsId, "telegram");
  }
  workerState.stats.sent++;
  log(
    "INFO",
    `[review] Sent approved pending_reply ${item.id} (${type}) to lead ${lead.id} via ${item.channel}`,
  );
}

// ─── Follow-up sequences ────────────────────────────────────────────

let isProcessingFollowUps = false;

// Шаг 3.3c-3: follow-up per-ws через store. Конфиг — из MktSetting воркспейса.
async function getFollowUpConfigStore(wsId) {
  let cfg = {};
  try {
    const row = await store.getSetting(wsId, "followup");
    if (row && row.value) cfg = JSON.parse(row.value);
  } catch {}
  return {
    enabled:
      cfg.enabled !== undefined
        ? !!cfg.enabled
        : process.env.FOLLOWUP_ENABLED === "true",
    delay_days: parseInt(
      cfg.delay_days || process.env.FOLLOWUP_DELAY_DAYS || "3",
      10,
    ),
    max_attempts: parseInt(
      cfg.max_attempts || process.env.FOLLOWUP_MAX_ATTEMPTS || "2",
      10,
    ),
  };
}

async function processFollowUps() {
  if (!workerState.running) return;
  if (isProcessingFollowUps) return;
  isProcessingFollowUps = true;
  try {
    for (const wsId of await store.listActiveWorkspaceIds()) {
      try {
        await _processFollowUpsForWs(wsId);
      } catch (e) {
        log("ERR", `processFollowUps ws ${wsId}: ${e.message}`);
        workerState.stats.errors++;
      }
    }
  } finally {
    isProcessingFollowUps = false;
  }
}

async function _processFollowUpsForWs(wsId) {
  const cfg = await getFollowUpConfigStore(wsId);
  if (!cfg.enabled) return;
  const cutoff = new Date(
    Date.now() - cfg.delay_days * 24 * 3600 * 1000,
  ).toISOString();
  const candidates = await store.pickFollowUpCandidates(wsId, {
    maxAttempts: cfg.max_attempts,
    cutoffIso: cutoff,
    limit: 20,
  });
  if (candidates.length === 0) return;
  const project = await store.getActiveProject(wsId);
  if (!project) return;

  ai.setUsageWorkspace(wsId);
  try {
    for (const row of candidates) {
      try {
        if (!row.last_out_at) continue;
        const lead = await store.getLead(wsId, row.id);
        const history = await store.listMessagesByDialogue(wsId, row.dlg_id);
        const attempt = (lead.followup_attempts || 0) + 1;

        log(
          "INFO",
          `Follow-up #${attempt} for lead ${lead.id} (silent since ${row.last_out_at})`,
        );
        const reply = await ai.generateFollowUp(
          lead,
          project,
          history,
          row.dlg_channel,
          attempt,
          wsId,
        );
        if (!reply || !reply.body) {
          log("WARN", `Follow-up empty for lead ${lead.id}`);
          continue;
        }
        const now = new Date().toISOString();
        const recipient =
          row.dlg_channel === "email"
            ? parseEmailList(lead.email)[0]
            : parseTelegramHandle(lead.telegram);

        // Review mode → в очередь
        if (await isReviewModeStore(wsId)) {
          if (await store.hasPendingForChannel(wsId, lead.id, row.dlg_channel))
            continue;
          const followupStageReview =
            attempt >= 2 ? "followup_2" : "followup_1";
          await queueReplyStore(wsId, {
            lead_id: lead.id,
            dialogue_id: row.dlg_id,
            channel: row.dlg_channel,
            recipient,
            subject: reply.subject || "Re:",
            body: reply.body,
            context: {
              type: "reply",
              next_stage: followupStageReview,
              followup: attempt,
            },
          });
          await store.incrementLeadFollowUp(wsId, now, now, lead.id);
          continue;
        }

        // Прямая отправка
        const daily = await store.getDailyCounts(wsId, todayKey());
        if (row.dlg_channel === "email" && daily.sent_email >= DAILY_CAP_EMAIL)
          continue;
        if (row.dlg_channel === "telegram" && daily.sent_tg >= DAILY_CAP_TG)
          continue;

        let metadata = { followup: attempt };
        let trackingId = null;
        if (row.dlg_channel === "email") {
          trackingId = generateTrackingId();
          const trackingPixelUrl = buildTrackingPixelUrl(wsId, trackingId);
          const replyToHeader = await store.getLastOutResendId(
            wsId,
            row.dlg_id,
          );
          const firstMeta = history[0]
            ? safeJsonParse(history[0].metadata)
            : {};
          const result = await email.sendEmail({
            to: recipient,
            subject: reply.subject || "Re: " + (firstMeta.subject || ""),
            body: reply.body,
            replyToHeader,
            trackingPixelUrl,
          });
          metadata.subject = reply.subject;
          metadata.resend_id = result.id;
        } else if (row.dlg_channel === "telegram") {
          const result = await sendTelegramBound(
            wsId,
            row.dlg_id,
            recipient,
            reply.body,
          );
          metadata.tg_message_id = result.messageId;
          metadata.chat_id = result.chatId;
          metadata.account_id = result.accountId;
          await bumpDaily(wsId, "telegram");
        }

        const followupStage = attempt >= 2 ? "followup_2" : "followup_1";
        await store.insertMessage(wsId, {
          dialogue_id: row.dlg_id,
          direction: "out",
          sender: "agent",
          content: reply.body,
          metadata: JSON.stringify(metadata),
          resend_id: metadata.resend_id ?? null,
          created_at: now,
          tracking_id: trackingId,
        });
        if (row.dlg_channel === "email") {
          await store.upsertDailyCounters(wsId, {
            date: todayKey(),
            sent_email: 1,
            sent_tg: 0,
            ai_input_tokens: 0,
            ai_output_tokens: 0,
            ai_cache_read: 0,
            ai_cache_creation: 0,
          });
        }
        await store.incrementLeadFollowUp(wsId, now, now, lead.id);
        await store.updateLeadStage(wsId, followupStage, now, lead.id);
        workerState.stats.sent++;
        log(
          "INFO",
          `Follow-up #${attempt} sent to lead ${lead.id} via ${row.dlg_channel}`,
        );
      } catch (e) {
        log("ERR", `Follow-up failed for lead ${row.id}: ${e.message}`);
        workerState.stats.errors++;
      }
    }
  } finally {
    ai.setUsageWorkspace(null);
  }
}

// Вызывается из routes/pending-replies при reject, чтобы освободить лида.
async function onPendingReplyRejected(wsId, pendingReplyId) {
  try {
    const item = await store.getPendingReply(wsId, pendingReplyId);
    if (!item) return;
    const ctx = safeJsonParse(item.context);
    // Для initial → освободить лид (ready/not_contacted), чтобы воркер перегенерил.
    if (ctx.type === "initial" && item.lead_id) {
      await store.resetLeadForRun(wsId, item.lead_id, true);
    }
  } catch (e) {
    log("ERR", "onPendingReplyRejected: " + e.message);
  }
}

// ─── Telegram incoming handler ──────────────────────────────────────

// Дебаунс генерации ответа: если блогер шлёт пачку сообщений подряд, генерируем
// ОДИН ответ после «тишины» TG_REPLY_DEBOUNCE_MS, чтобы прочитать всю пачку.
const TG_REPLY_DEBOUNCE_MS = parseInt(
  process.env.TG_REPLY_DEBOUNCE_MS || "12000",
  10,
);
const _tgReplyTimers = new Map(); // key `${wsId}:${leadId}` → timeout

// Запуск reply-gen для воркспейса (wsId — cuid из findTgLeadMatch). Всё на store.
async function _runReplyGenForWorkspace(wsId) {
  await generatePendingReplies(wsId);
}

// Поставить/сбросить per-lead дебаунс-таймер генерации ответа. Каждое новое
// входящее по этому лиду сбрасывает таймер → ответ читает уже всю пачку.
function scheduleTgReplyGeneration(wsId, leadId) {
  const key = `${wsId}:${leadId}`;
  const existing = _tgReplyTimers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    _tgReplyTimers.delete(key);
    _runReplyGenForWorkspace(wsId).catch((e) =>
      log(
        "ERR",
        `debounced TG reply gen failed (lead #${leadId}): ${e.message}`,
      ),
    );
  }, TG_REPLY_DEBOUNCE_MS);
  if (typeof t.unref === "function") t.unref(); // не держим event loop
  _tgReplyTimers.set(key, t);
  log(
    "DEBUG",
    `TG reply debounce armed (lead #${leadId}, ws ${wsId}, ${TG_REPLY_DEBOUNCE_MS}ms)`,
  );
}

async function handleIncomingTelegram(msg) {
  if (!msg.username && !msg.senderId) return;

  // Матч лида по всем воркспейсам через store (TG общий, лиды разнесены).
  const match = await store.findTgLeadMatch(msg.username, msg.chatId);
  if (!match) {
    log(
      "WARN",
      `TG message from @${msg.username || msg.senderId} — no matching lead (любой ws)`,
    );
    return;
  }

  const wsId = match.wsId;
  try {
    const lead = match.lead;
    let dialogue = match.dialogue;

    // Дедуп по tg_message_id (защита от double-приёма live + catch-up).
    if (msg.messageId && dialogue) {
      const dup = await store.tgIncomingExists(wsId, lead.id, msg.messageId);
      if (dup) {
        // Сообщение уже записано. Нет активного черновика → дебаунс-регенерация.
        if (!(await store.hasPendingForChannel(wsId, lead.id, "telegram"))) {
          log(
            "INFO",
            `TG incoming dup (lead ${lead.id}) — нет активного черновика, дебаунс-регенерация`,
          );
          scheduleTgReplyGeneration(wsId, lead.id);
        } else {
          log(
            "INFO",
            `TG incoming dup skipped (lead ${lead.id}, msg ${msg.messageId})`,
          );
        }
        return;
      }
    }

    const now = new Date().toISOString();
    if (!dialogue) {
      const d = await store.insertDialogue(
        wsId,
        lead.id,
        "telegram",
        msg.chatId,
        now,
      );
      dialogue = {
        id: d.id,
        lead_id: lead.id,
        channel: "telegram",
        account_id: null,
      };
    }
    // Привязка диалога к аккаунту, получившему входящее (backfill).
    if (msg.accountId != null && dialogue.account_id == null) {
      await store.setDialogueAccount(wsId, msg.accountId, dialogue.id);
    }
    await store.insertMessage(wsId, {
      dialogue_id: dialogue.id,
      direction: "in",
      sender: "blogger",
      content: msg.text,
      metadata: JSON.stringify({
        username: msg.username,
        tg_message_id: msg.messageId,
        chat_id: msg.chatId,
        account_id: msg.accountId ?? null,
      }),
      created_at: now,
      tracking_id: null,
    });
    await store.updateLeadStage(wsId, "replied", now, lead.id);

    workerState.stats.replied++;
    log(
      "INFO",
      `TG reply from @${msg.username} (lead ${lead.id}, ws: ${wsId})`,
    );

    // Дебаунс: не генерируем ответ сразу — ждём «тишины», чтобы прочитать всю
    // пачку. Запись входящего и стадия replied уже зафиксированы выше (мгновенно).
    scheduleTgReplyGeneration(wsId, lead.id);
  } catch (e) {
    log("ERR", `TG handler failed: ${e.message}`);
  }
}

// Startup-sweep: дебаунс-таймеры in-memory и теряются при рестарте. Один проход
// generatePendingReplies по воркспейсам, где есть «зависшая» TG-пачка (входящие
// после последнего исходящего, без активного черновика) — подберём её. Reentrancy-
// guard + review-дедуп защищают от дублей. Сканируем только ws с реальной TG-
// пачкой. Через store: итерируем активные воркспейсы и зовём reply-gen — он
// сам (pickLeadsWithNewReplies + reentrancy + review-дедуп) подберёт зависшие
// пачки (новый IN без ответа), TG в т.ч. Без файлового скана.
async function sweepStrandedTgReplies() {
  for (const wsId of await store.listActiveWorkspaceIds()) {
    try {
      await _runReplyGenForWorkspace(wsId);
    } catch (e) {
      log("ERR", `[sweep] ws ${wsId}: ${e.message}`);
    }
  }
}

// Подключить ТОЛЬКО приём входящих TG (без outreach/inbox/followup циклов).
// Безопасно при DRY_RUN=false: ничего не рассылает, входящие в review-режиме
// кладутся в pending_replies. Идемпотентно.
let _tgListenerEnabled = false;
function enableTelegramListener() {
  if (_tgListenerEnabled) return;
  tg.onMessage(handleIncomingTelegram);
  _tgListenerEnabled = true;
  log(
    "INFO",
    "TG incoming listener enabled (listener-only, без outreach-цикла)",
  );
  // Подобрать пачки, пришедшие пока сервер был выключен (таймеры теряются на рестарт).
  setTimeout(() => {
    sweepStrandedTgReplies().catch((e) =>
      log("ERR", `startup TG sweep failed: ${e.message}`),
    );
  }, 5000);
}

// ─── Control ────────────────────────────────────────────────────────

function start() {
  if (workerState.running) return;
  workerState.running = true;
  workerState.lastError = null;

  tg.onMessage(handleIncomingTelegram);

  workerState.outreachInterval = setInterval(
    processOutreachQueue,
    OUTREACH_TICK_MS,
  );
  workerState.inboxInterval = setInterval(processInbox, INBOX_TICK_MS);
  workerState.decisionsInterval = setInterval(async () => {
    await processDecidedDeals();
    await processAnsweredConsultations();
    await processApprovedQueue();
  }, 20_000);
  // Follow-up проверяется реже (раз в 15 мин)
  workerState.followUpInterval = setInterval(processFollowUps, 15 * 60 * 1000);
  setTimeout(processFollowUps, 60_000);
  log(
    "INFO",
    `Outreach worker started (TG ready: ${tg.isReady()}, AdminBot: ${adminBot.isReady()}, ReviewMode env: ${process.env.REVIEW_MODE === "true" || process.env.REVIEW_MODE === "1"})`,
  );
  setTimeout(processOutreachQueue, 1000);
  setTimeout(processInbox, 3000);
  setTimeout(processDecidedDeals, 5000);
  setTimeout(processApprovedQueue, 7000);
}

// ─── Диспетчер очереди отправки ──────────────────────────────────────
// Одобренные письма ждут своего send_after и уходят отсюда. Живёт ОТДЕЛЬНО от
// start()/stop(): очередь наполняет человек кнопкой «Одобрить», и письмо обязано
// уйти даже если outreach-воркер не поднят (нет IMAP_HOST) или остановлен из UI.
// Иначе письма молча копятся в APPROVED навсегда.
let sendQueueInterval = null;
const SEND_QUEUE_TICK_MS = 20_000;
// Критерий «зависло» — claim от ПРОШЛОГО процесса, а не просто давний.
// По времени тут судить нельзя: TG-пейсинг (глобальная очередь, до 90 с на
// сообщение) легально держит запись в SENDING десятки минут, и порог по возрасту
// вернул бы в очередь письмо, которое прямо сейчас отправляется, — блогер получил
// бы дубль. Всё, что заклеймлено до старта текущего процесса, отправиться уже не
// может: тот процесс мёртв.
const PROCESS_START_ISO = new Date().toISOString();

function startSendQueueDispatcher() {
  if (sendQueueInterval) return;
  const tick = async () => {
    try {
      const revived = await store.resetStaleSendingReplies(PROCESS_START_ISO);
      if (revived > 0)
        log("INFO", `send-queue: возвращено из sending в очередь: ${revived}`);
    } catch (e) {
      log("ERR", `send-queue sweep: ${e.message}`);
    }
    try {
      await processApprovedQueue();
    } catch (e) {
      log("ERR", `send-queue tick: ${e.message}`);
    }
  };
  sendQueueInterval = setInterval(tick, SEND_QUEUE_TICK_MS);
  setTimeout(tick, 5000);
  log("INFO", "Send queue dispatcher started");
}

function stop() {
  if (!workerState.running) return;
  workerState.running = false;
  if (workerState.outreachInterval) clearInterval(workerState.outreachInterval);
  if (workerState.inboxInterval) clearInterval(workerState.inboxInterval);
  if (workerState.decisionsInterval)
    clearInterval(workerState.decisionsInterval);
  if (workerState.followUpInterval) clearInterval(workerState.followUpInterval);
  workerState.outreachInterval = null;
  workerState.inboxInterval = null;
  workerState.decisionsInterval = null;
  workerState.followUpInterval = null;
  log("INFO", "Outreach worker stopped");
}

// Глобальный статус воркера (агрегат по всем активным воркспейсам, store).
async function status() {
  const wsIds = await store.listActiveWorkspaceIds();
  let ready = 0,
    in_work = 0,
    sent_email = 0,
    sent_tg = 0,
    pending_review = 0,
    reviewAny = false;
  const date = todayKey();
  for (const wsId of wsIds) {
    const c = await store.countLeads(wsId);
    ready += c.ready || 0;
    in_work += c.in_work || 0;
    const d = await store.getDailyCounts(wsId, date);
    sent_email += d.sent_email;
    sent_tg += d.sent_tg;
    pending_review += (await store.countPendingReplies(wsId, "pending")).n || 0;
    if (await isReviewModeStore(wsId)) reviewAny = true;
  }
  return {
    running: workerState.running,
    lastTick: workerState.lastTick,
    lastError: workerState.lastError,
    stats: workerState.stats,
    queue: { ready, in_work },
    daily: {
      sent_email,
      sent_tg,
      cap_email: DAILY_CAP_EMAIL,
      cap_tg: DAILY_CAP_TG,
    },
    review_mode: reviewAny,
    pending_review,
  };
}

module.exports = {
  start,
  stop,
  startSendQueueDispatcher,
  status,
  getLogs,
  processOutreachQueue,
  processInbox,
  processDecidedDeals,
  processAnsweredConsultations,
  processApprovedQueue,
  processFollowUps,
  runLeadNow,
  runLeadsNow,
  channelAvailability,
  handleIncomingTelegram,
  enableTelegramListener,
  sweepStrandedTgReplies,
  onPendingReplyRejected,
  // entry points для inbox/reply-gen (используются processInbox; экспорт для тестов/триггеров)
  generatePendingReplies,
  _ingestIncomingEmail,
  // тест-хук: включить running без планирования интервалов start()
  __setRunning: (v) => {
    workerState.running = !!v;
  },
};
