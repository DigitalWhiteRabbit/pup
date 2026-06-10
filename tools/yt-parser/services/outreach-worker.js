const crypto = require("crypto");
const dbModule = require("../db/database");
let { stmts, db } = dbModule;
const ai = require("./ai");
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

let currentWorkspaceId = "default";

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

// ─── Review mode ────────────────────────────────────────────────────
// Флаг в settings (key='review_mode', value='1'/'0'). Fallback на ENV REVIEW_MODE=true.
function isReviewMode() {
  try {
    const row = stmts.getSetting.get("review_mode");
    if (row && row.value) return row.value === "1" || row.value === "true";
  } catch {}
  return process.env.REVIEW_MODE === "true" || process.env.REVIEW_MODE === "1";
}

// Положить reply в очередь на проверку вместо немедленной отправки.
// context: { type: 'initial'|'reply'|'deal_accept'|'consultation_answer', ...extra }
function queueReply({
  lead_id,
  dialogue_id = null,
  channel,
  recipient,
  subject = null,
  body,
  context = {},
}) {
  const now = new Date().toISOString();
  const result = stmts.insertPendingReply.run({
    lead_id,
    dialogue_id,
    channel,
    recipient,
    subject,
    body,
    context: JSON.stringify(context),
    created_at: now,
  });
  log(
    "INFO",
    `[review] queued pending_reply #${result.lastInsertRowid} for lead #${lead_id} (${context.type})`,
  );
  // Уведомим админа в TG если bot готов
  if (adminBot.isReady() && typeof adminBot.notifyPendingReply === "function") {
    const pr = stmts.getPendingReply.get(result.lastInsertRowid);
    adminBot
      .notifyPendingReply(pr)
      .catch((e) => log("ERR", "notifyPendingReply: " + e.message));
  }
  return result.lastInsertRowid;
}

// Есть ли у лида/диалога уже pending или approved reply (чтобы не плодить дубликаты)
function hasActivePendingReply(lead_id, dialogue_id = null) {
  const row = db
    .prepare(
      `
    SELECT id FROM pending_replies
    WHERE lead_id = ? AND (dialogue_id IS ? OR dialogue_id = ?) AND status IN ('pending','approved')
    LIMIT 1
  `,
    )
    .get(lead_id, dialogue_id, dialogue_id);
  return !!row;
}

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

function getDailyCounts() {
  const row = stmts.getDailyCounters.get(todayKey());
  return { sent_email: row?.sent_email || 0, sent_tg: row?.sent_tg || 0 };
}

function incrementDailyCount(channel) {
  stmts.upsertDailyCounters.run({
    date: todayKey(),
    sent_email: channel === "email" ? 1 : 0,
    sent_tg: channel === "telegram" ? 1 : 0,
    ai_input_tokens: 0,
    ai_output_tokens: 0,
    ai_cache_read: 0,
    ai_cache_creation: 0,
  });
}

// Atomic pick + lock (pickAndLockNextLead в транзакции)
const pickAndLockNextLead = db.transaction(() => {
  const now = Date.now();
  const lead = stmts.pickNextLeadForOutreach.get({ now });
  if (!lead) return null;
  stmts.lockLead.run(now + LOCK_DURATION_MS, lead.id);
  return lead;
});

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

// Каналы, по которым лиду уже уходило исходящее (для идемпотентности).
function existingOutChannels(leadId) {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT d.channel FROM dialogues d
         JOIN messages m ON m.dialogue_id = d.id
         WHERE d.lead_id = ? AND m.direction = 'out'`,
      )
      .all(leadId);
    return new Set(rows.map((r) => r.channel));
  } catch {
    return new Set();
  }
}

// Есть ли уже активная (pending/approved) очередь по каналу для лида —
// чтобы повторный «Запустить» не плодил дубли в ревью-режиме.
function hasPendingForChannel(leadId, channel) {
  try {
    const row = db
      .prepare(
        `SELECT id FROM pending_replies
         WHERE lead_id = ? AND channel = ? AND status IN ('pending','approved') LIMIT 1`,
      )
      .get(leadId, channel);
    return !!row;
  } catch {
    return false;
  }
}

const ALL_CHANNELS = ["email", "telegram"];

// Разрешить итоговый набор каналов для отправки: (запрошенные|все доступные)
// ∩ доступные − уже отправленные − уже в очереди.
function resolveChannels(lead, requested) {
  const avail = channelAvailability(lead);
  const available = ALL_CHANNELS.filter((c) => avail[c]);
  const want =
    Array.isArray(requested) && requested.length
      ? requested.filter((c) => available.includes(c))
      : available;
  const alreadyOut = existingOutChannels(lead.id);
  const selected = want.filter(
    (c) => !alreadyOut.has(c) && !hasPendingForChannel(lead.id, c),
  );
  return { available, want, alreadyOut, selected };
}

function recipientFor(lead, channel) {
  return channel === "email"
    ? parseEmailList(lead.email)[0]
    : parseTelegramHandle(lead.telegram);
}

// Отправка ответа в TG ТЕМ ЖЕ аккаунтом, что ведёт диалог (dialogues.account_id).
// Если у диалога ещё нет привязки — выбираем здоровый аккаунт и фиксируем его.
async function sendTelegramBound(dialogueId, recipient, text) {
  let accountId = null;
  if (dialogueId) {
    const d = stmts.getDialogue.get(dialogueId);
    if (d && d.account_id != null) accountId = d.account_id;
  }
  if (accountId == null) accountId = tg.pickAccount();
  if (accountId == null)
    throw new Error("нет доступного TG-аккаунта (залогинен/под лимитом)");
  const result = await tg.sendMessageVia(accountId, recipient, text);
  if (dialogueId) {
    const d = stmts.getDialogue.get(dialogueId);
    if (d && d.account_id == null)
      stmts.setDialogueAccount.run(result.accountId, dialogueId);
  }
  return result;
}

// Match lead by exact email address (lowercase). Берём lead'ов с lead_status in work/done и потом фильтруем.
function findLeadByEmail(fromAddr) {
  if (!fromAddr) return null;
  const needle = String(fromAddr).toLowerCase().trim();
  // Сначала быстрый exact match через индексированную таблицу lead_emails
  try {
    const exact = stmts.findLeadByEmailExact.get(needle);
    if (exact) return exact;
  } catch (e) {
    /* fallback ниже */
  }
  // Fallback (на случай если lead_emails ещё не заполнена для этого лида)
  const candidates = db
    .prepare(`SELECT * FROM leads WHERE email IS NOT NULL AND email != ''`)
    .all();
  for (const l of candidates) {
    const list = parseEmailList(l.email);
    if (list.includes(needle)) return l;
  }
  return null;
}

// Найти диалог по In-Reply-To / References по сохранённому resend_id в messages.metadata
function findDialogueByReplyHeaders(inReplyTo, references) {
  const ids = new Set();
  const extractIds = (str) => {
    if (!str) return;
    const matches = String(str).match(/<[^>]+>|[^\s<>]+/g) || [];
    matches.forEach((id) => ids.add(id.replace(/^<|>$/g, "")));
  };
  extractIds(inReplyTo);
  extractIds(references);
  if (ids.size === 0) return null;

  for (const id of ids) {
    const row = db
      .prepare(
        `
      SELECT d.* FROM messages m
      JOIN dialogues d ON d.id = m.dialogue_id
      WHERE m.resend_id = ?
      LIMIT 1
    `,
      )
      .get(id);
    if (row) return row;
  }
  return null;
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

async function processOutreachQueue() {
  if (!workerState.running) return;
  if (isProcessingOutreach) return;
  isProcessingOutreach = true;
  workerState.lastTick = new Date().toISOString();

  try {
    const project = stmts.getActiveProject.get();
    if (!project) {
      log("WARN", "No active project — outreach paused");
      return;
    }

    // Daily cap check
    const counts = getDailyCounts();
    if (
      counts.sent_email >= DAILY_CAP_EMAIL &&
      counts.sent_tg >= DAILY_CAP_TG
    ) {
      log(
        "INFO",
        `Daily cap reached (email=${counts.sent_email}/${DAILY_CAP_EMAIL}, tg=${counts.sent_tg}/${DAILY_CAP_TG})`,
      );
      return;
    }

    // Атомарный pick+lock
    const lead = pickAndLockNextLead();
    if (!lead) return;

    await _processPickedLead(lead, project, counts);
  } catch (e) {
    log("ERR", `Outreach tick failed: ${e.message}`);
    workerState.lastError = e.message;
    workerState.stats.errors++;
  } finally {
    isProcessingOutreach = false;
  }
}

// Отправка одного initial-питча по конкретному каналу: реальная/DRY отправка,
// запись dialogue + message, инкремент дневного счётчика. Для TG — привязка
// диалога к аккаунту (account_id) и отправка через пейсинг-очередь.
// Возвращает true при успехе.
async function _sendInitialOnChannel(lead, channel, recipient, pitch, now) {
  let externalId = null;
  let metadata = { recipient };
  let trackingId = null;
  let accountId = null;

  // Для TG заранее выбираем здоровый аккаунт — он же фиксируется в диалоге.
  if (channel === "telegram") {
    accountId = tg.pickAccount();
  }

  if (DRY_RUN) {
    log(
      "INFO",
      `[DRY_RUN] Would send ${channel} to ${recipient}${
        accountId != null ? ` via acc#${accountId}` : ""
      }\n${channel === "email" ? "Subject: " + (pitch.subject || "") + "\n" : ""}${pitch.body}`,
    );
    db.prepare(
      `INSERT INTO dry_run_log (created_at, lead_id, channel, subject, body, would_send_to) VALUES (?,?,?,?,?,?)`,
    ).run(
      now,
      lead.id,
      channel,
      channel === "email" ? pitch.subject || null : null,
      pitch.body,
      recipient,
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
    const trackingPixelUrl = buildTrackingPixelUrl(
      currentWorkspaceId,
      trackingId,
    );
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

  const tx = db.transaction(() => {
    const dlgResult = stmts.insertDialogue.run(
      lead.id,
      channel,
      externalId,
      now,
    );
    if (channel === "telegram" && accountId != null)
      stmts.setDialogueAccount.run(accountId, dlgResult.lastInsertRowid);
    stmts.insertMessage.run({
      dialogue_id: dlgResult.lastInsertRowid,
      direction: "out",
      sender: "agent",
      content: pitch.body,
      metadata: JSON.stringify(metadata),
      created_at: now,
      tracking_id: trackingId,
    });
    stmts.incrementDialogueMsgCount.run(dlgResult.lastInsertRowid);
  });
  tx();

  incrementDailyCount(channel);
  workerState.stats.sent++;
  log(
    "INFO",
    `Sent ${channel} to ${recipient} (lead #${lead.id})${
      accountId != null ? ` via acc#${accountId}` : ""
    }`,
  );
  return true;
}

// Обработка конкретного (уже взятого и залоченного) лида.
// options.channels — каналы из пикера (["email","telegram"]); если не заданы —
// все доступные каналы лида.
async function _processPickedLead(lead, project, counts, options = {}) {
  try {
    log("INFO", `Processing lead #${lead.id} ${lead.channel_name}`);

    // Auto-enrich lead if missing videos/about
    try {
      const { enrichLead } = require("./enrichment");
      await enrichLead(lead, db);
    } catch (e) {
      log("WARN", `Enrichment failed for lead #${lead.id}: ${e.message}`);
    }

    // Auto-score lead after enrichment
    try {
      const scoring = require("./lead-scoring");
      const videoAnalysis = scoring.analyzeVideos
        ? scoring.analyzeVideos(lead.last_videos_json)
        : null;
      const project2 = stmts.getActiveProject.get();
      const { score, breakdown } = scoring.computeScore
        ? scoring.computeScore(
            lead,
            videoAnalysis,
            project2?.ideal_channel_profile,
            project2?.bad_fit_examples,
          )
        : { score: 50, breakdown: {} };
      lead.lead_score = score;
      lead.score_breakdown = JSON.stringify(breakdown);
      db.prepare(
        "UPDATE leads SET lead_score = ?, score_breakdown = ?, scored_at = ? WHERE id = ?",
      ).run(score, lead.score_breakdown, new Date().toISOString(), lead.id);
      log("INFO", `Lead #${lead.id} scored: ${score}/100`);
    } catch (e) {
      log("WARN", `Scoring failed for lead #${lead.id}: ${e.message}`);
    }

    // ─── Авто-сводка (content_summary) перед генерацией питча (TZ §6) ──
    // Только если пусто (сделанное человеком/ранее не трогаем). Ошибка не фатальна.
    if (!lead.content_summary) {
      try {
        const summary = await ai.generateContentSummary(lead, project);
        db.prepare(
          "UPDATE leads SET content_summary = ?, updated_at = ? WHERE id = ?",
        ).run(summary, new Date().toISOString(), lead.id);
        lead.content_summary = summary;
        log("INFO", `Lead #${lead.id} content_summary auto-generated`);
      } catch (e) {
        log("WARN", `summary failed lead #${lead.id}: ${e.message}`);
      }
    }

    // Opted-out check (GDPR)
    if (lead.opted_out) {
      log("INFO", `Lead #${lead.id} opted out — skipping`);
      stmts.unlockLead.run(lead.id);
      return;
    }

    // ─── Каналы для отправки (мультиканал) ───────────────────────────
    const { available, want, alreadyOut, selected } = resolveChannels(
      lead,
      options.channels,
    );
    if (selected.length === 0) {
      log(
        "WARN",
        `Lead #${lead.id}: нечего слать — доступно=[${available}] запрошено=[${want}] уже_отправлено=[${[...alreadyOut]}]; пропуск`,
      );
      // Если у лида в принципе нет контактов/живых каналов — длинный лок.
      // Если просто всё уже отправлено — помечаем contacted, чтобы не зацикливать.
      if (alreadyOut.size > 0) {
        stmts.updateLeadStage.run(
          "contacted",
          new Date().toISOString(),
          lead.id,
        );
        stmts.unlockLead.run(lead.id);
      } else {
        stmts.lockLead.run(Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      }
      return;
    }

    // ─── P1: fit-gate — отсеиваем несовместимые каналы до генерации питча ──
    let pitchAngle = null;
    try {
      const qual = await ai.qualifyLead(lead, project);
      log(
        "INFO",
        `Lead #${lead.id} fit-gate: suitable=${qual.suitable}, angle=${qual.angle}, reason=${qual.reason}`,
      );
      pitchAngle = qual.angle || null;
    } catch (e) {
      log(
        "WARN",
        `fit-gate failed for lead #${lead.id}: ${e.message} — proceeding without gate`,
      );
    }

    // Питч генерим ОДИН раз в email-стиле (subject + body). Для TG берём тело
    // как есть, без subject (решение ТЗ §3.2).
    let pitch;
    try {
      pitch = await ai.generateInitialPitch(lead, project, "email", pitchAngle);
    } catch (e) {
      log("ERR", `AI generation failed for lead #${lead.id}: ${e.message}`);
      workerState.lastError = e.message;
      workerState.stats.errors++;
      stmts.lockLead.run(Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      return;
    }

    if (!pitch.body) {
      log("ERR", `AI returned empty pitch for lead #${lead.id}`);
      stmts.lockLead.run(Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      return;
    }

    const now = new Date().toISOString();

    // ─── Review mode: по строке pending_reply на каждый выбранный канал ──
    if (isReviewMode()) {
      let queued = 0;
      for (const channel of selected) {
        const recipient = recipientFor(lead, channel);
        if (!recipient) continue;
        queueReply({
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
        stmts.updateLeadStage.run("awaiting_review", now, lead.id);
        stmts.updateLeadStatus.run("in_work", now, lead.id);
        stmts.lockLead.run(Date.now() + 60 * 60 * 1000, lead.id);
      } else {
        stmts.lockLead.run(Date.now() + LOCK_DURATION_ERR_MS, lead.id);
      }
      return;
    }

    // ─── Прямая отправка по каждому выбранному каналу ────────────────
    let sentAny = false;
    for (const channel of selected) {
      const recipient = recipientFor(lead, channel);
      if (!recipient) {
        log("WARN", `Lead #${lead.id} пустой recipient для ${channel}`);
        continue;
      }
      const dc = getDailyCounts();
      if (channel === "email" && dc.sent_email >= DAILY_CAP_EMAIL) {
        log("INFO", `email daily cap reached — пропуск email lead #${lead.id}`);
        continue;
      }
      if (channel === "telegram" && dc.sent_tg >= DAILY_CAP_TG) {
        log("INFO", `tg daily cap reached — пропуск tg lead #${lead.id}`);
        continue;
      }
      try {
        const ok = await _sendInitialOnChannel(
          lead,
          channel,
          recipient,
          pitch,
          now,
        );
        if (ok) sentAny = true;
      } catch (e) {
        log("ERR", `${channel} send failed for lead #${lead.id}: ${e.message}`);
        workerState.lastError = e.message;
        workerState.stats.errors++;
      }
    }

    if (sentAny) {
      const ts = new Date().toISOString();
      stmts.updateLeadStage.run("awaiting_reply", ts, lead.id);
      stmts.updateLeadStatus.run("in_work", ts, lead.id);
      stmts.updateLeadProject.run(project.id, ts, lead.id);
      stmts.unlockLead.run(lead.id);
    } else {
      stmts.lockLead.run(Date.now() + LOCK_DURATION_ERR_MS, lead.id);
    }
  } catch (e) {
    log("ERR", `_processPickedLead failed for #${lead.id}: ${e.message}`);
    workerState.lastError = e.message;
    workerState.stats.errors++;
    stmts.lockLead.run(Date.now() + LOCK_DURATION_ERR_MS, lead.id);
  }
}

// Немедленная обработка конкретного лида (по кнопке «Запустить» в UI).
// channels — выбор каналов из пикера (["email","telegram"]) или null = все доступные.
async function runLeadNow(leadId, workspaceId, channels = null) {
  // Swap module-level stmts/db to workspace-specific ones
  const savedStmts = stmts;
  const savedDb = db;
  const savedWsId = currentWorkspaceId;

  if (workspaceId) {
    const ws = dbModule.getDb(workspaceId);
    stmts = ws.stmts;
    db = ws.db;
    currentWorkspaceId = workspaceId;
  }

  try {
    const project = stmts.getActiveProject.get();
    if (!project) throw new Error("no active project");
    const lead = stmts.getLead.get(leadId);
    if (!lead) throw new Error("lead not found");
    if (lead.lead_status !== "ready")
      throw new Error(`lead_status is "${lead.lead_status}", expected "ready"`);

    stmts.lockLead.run(Date.now() + LOCK_DURATION_MS, lead.id);
    const counts = getDailyCounts();
    await _processPickedLead(
      { ...lead, locked_until: Date.now() + LOCK_DURATION_MS },
      project,
      counts,
      { channels },
    );
  } finally {
    stmts = savedStmts;
    db = savedDb;
    currentWorkspaceId = savedWsId;
  }
}

// Последовательный запуск нескольких лидов (bulk «Запустить»): по очереди,
// без параллелизма — чтобы не было гонки stmts-свопа и всплеска вызовов API.
async function runLeadsNow(leadIds, workspaceId, channels = null) {
  for (const id of leadIds || []) {
    try {
      await runLeadNow(id, workspaceId, channels);
    } catch (e) {
      log("WARN", `bulk-run lead #${id}: ${e.message}`);
    }
  }
}

// ─── Cross-workspace lead lookup ────────────────────────────────────

function findLeadAcrossWorkspaces(fromAddr, inReplyTo, references) {
  const fs = require("fs");
  const path = require("path");
  const dataDir = path.join(__dirname, "..", "data");
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("ws-") && f.endsWith(".db"));

  for (const file of files) {
    const wsId = file.replace("ws-", "").replace(".db", "");
    const ws = dbModule.getDb(wsId);

    // Try reply headers first
    if (inReplyTo || references) {
      const ids = new Set();
      const extract = (s) => {
        if (s) for (const m of String(s).matchAll(/<([^>]+)>/g)) ids.add(m[1]);
      };
      extract(inReplyTo);
      extract(references);
      for (const id of ids) {
        const row = ws.db
          .prepare(
            `SELECT d.* FROM messages m JOIN dialogues d ON d.id = m.dialogue_id WHERE m.resend_id = ? LIMIT 1`,
          )
          .get(id);
        if (row) {
          const lead = ws.stmts.getLead.get(row.lead_id);
          if (lead) return { lead, dialogue: row, wsId, ws };
        }
      }
    }

    // Fallback: email match
    if (fromAddr) {
      const needle = String(fromAddr).toLowerCase().trim();
      const candidates = ws.db
        .prepare("SELECT * FROM leads WHERE email IS NOT NULL AND email != ''")
        .all();
      for (const l of candidates) {
        const list = parseEmailList(l.email);
        if (list.some((e) => e.toLowerCase() === needle)) {
          const dialogue = ws.db
            .prepare(
              "SELECT * FROM dialogues WHERE lead_id = ? AND channel = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(l.id, "email");
          return { lead: l, dialogue, wsId, ws };
        }
      }
    }
  }
  return null;
}

// ─── Inbox loop ─────────────────────────────────────────────────────

const _repliedWorkspaces = new Set();

async function processInbox() {
  if (!workerState.running) return;
  if (!process.env.RESEND_API_KEY || !process.env.IMAP_HOST) return;
  _repliedWorkspaces.clear();

  try {
    const messages = await email.fetchInbox();
    if (messages.length === 0) return;

    log("INFO", `Fetched ${messages.length} new emails`);

    for (const msg of messages) {
      let match = null;
      const savedStmts = stmts;
      const savedDb = db;
      const savedWsId = currentWorkspaceId;
      try {
        // Auto-reply detection
        if (email.isAutoReply(msg)) {
          log(
            "INFO",
            `Skipping auto-reply from ${msg.from} (subject: ${msg.subject})`,
          );
          await email.markSeen(msg.uid);
          continue;
        }

        // Search across ALL workspaces for matching lead
        match = findLeadAcrossWorkspaces(
          msg.from,
          msg.inReplyTo,
          msg.references,
        );
        let lead = match?.lead;
        let dialogue = match?.dialogue;

        // Swap to correct workspace DB for this lead
        if (match?.ws) {
          stmts = match.ws.stmts;
          db = match.ws.db;
          if (match.wsId) currentWorkspaceId = match.wsId;
        }

        if (!lead) {
          log(
            "WARN",
            `No matching lead for email from ${msg.from}, leaving unseen`,
          );
          if (match?.ws) {
            stmts = savedStmts;
            db = savedDb;
          }
          continue;
        }

        if (!dialogue) dialogue = stmts.getDialogueByLead.get(lead.id, "email");

        const now = new Date().toISOString();
        const tx = db.transaction(() => {
          if (!dialogue) {
            const r = stmts.insertDialogue.run(
              lead.id,
              "email",
              msg.messageId,
              now,
            );
            dialogue = {
              id: r.lastInsertRowid,
              lead_id: lead.id,
              channel: "email",
            };
          }
          stmts.insertMessage.run({
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
          stmts.incrementDialogueMsgCount.run(dialogue.id);
          stmts.updateLeadStage.run("replied", now, lead.id);
        });
        tx();

        // Теперь безопасно пометить seen
        await email.markSeen(msg.uid);

        workerState.stats.replied++;
        if (match?.wsId) _repliedWorkspaces.add(match.wsId);
        log(
          "INFO",
          `New reply from ${msg.from} (lead #${lead.id}, ws: ${match?.wsId || "default"})`,
        );
      } catch (e) {
        log("ERR", `Inbox message processing failed: ${e.message}`);
        workerState.stats.errors++;
      } finally {
        // Restore original DB context
        if (match?.ws) {
          stmts = savedStmts;
          db = savedDb;
          currentWorkspaceId = savedWsId;
        }
      }
    }
  } catch (e) {
    log("ERR", `Inbox poll failed: ${e.message}`);
    workerState.lastError = e.message;
    workerState.stats.errors++;
  }

  // Generate replies per workspace that had new messages
  for (const wsId of _repliedWorkspaces) {
    const ws = dbModule.getDb(wsId);
    const savedS = stmts;
    const savedD = db;
    const savedW = currentWorkspaceId;
    stmts = ws.stmts;
    db = ws.db;
    currentWorkspaceId = wsId;
    try {
      await generatePendingReplies();
    } finally {
      stmts = savedS;
      db = savedD;
      currentWorkspaceId = savedW;
    }
  }
  // Also try default workspace
  await generatePendingReplies();
}

// ─── Reply generation (with reentrancy guard + concurrency cap) ────

async function generatePendingReplies() {
  if (isProcessingReplies) {
    log("DEBUG", "generatePendingReplies already running, skipping");
    return;
  }
  isProcessingReplies = true;
  try {
    const leads = stmts.pickLeadsWithNewReplies.all();
    if (leads.length === 0) return;

    const project = stmts.getActiveProject.get();
    if (!project) return;

    // Обрабатываем последовательно, чтобы точно соблюдать daily cap
    // (параллельная обработка создавала race condition на счётчиках).
    const queue = leads.slice(0, 50);
    for (const lead of queue) {
      try {
        await processOneLeadReply(lead, project);
      } catch (e) {
        log(
          "ERR",
          `Reply generation failed for lead #${lead.id}: ${e.message}`,
        );
        workerState.lastError = e.message;
        workerState.stats.errors++;
      }
    }
  } finally {
    isProcessingReplies = false;
  }
}

async function processOneLeadReply(lead, project) {
  const dialogue = db
    .prepare(
      `SELECT * FROM dialogues WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(lead.id);
  if (!dialogue) return;
  // В review-mode не плодим дубли pending_replies для одного диалога
  if (isReviewMode() && hasActivePendingReply(lead.id, dialogue.id)) return;

  const history = stmts.listMessagesByDialogue.all(dialogue.id);

  // Loop detection: если уже слишком много сообщений — просим админа
  if (history.length >= LOOP_MESSAGE_LIMIT) {
    log(
      "WARN",
      `Lead #${lead.id} hit message limit ${LOOP_MESSAGE_LIMIT} — escalating to admin`,
    );
    const now = new Date().toISOString();
    const existing = db
      .prepare(
        `SELECT id FROM consultations WHERE lead_id = ? AND status = 'pending'`,
      )
      .get(lead.id);
    if (!existing) {
      const r = db
        .prepare(
          `INSERT INTO consultations (lead_id, question, context, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
        )
        .run(
          lead.id,
          `Диалог достиг ${history.length} сообщений без закрытия. Прошу подключиться вручную.`,
          JSON.stringify(history.slice(-5)),
          now,
        );
      if (adminBot.isReady()) {
        const consultation = db
          .prepare("SELECT * FROM consultations WHERE id = ?")
          .get(r.lastInsertRowid);
        adminBot
          .askConsultation(consultation, lead)
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
  );
  const now = new Date().toISOString();

  // Flag: price_mentioned → создать deal (с валидацией)
  if (reply.flag === "price_mentioned" && reply.extracted_price) {
    if (!validatePriceMention(history, reply.extracted_price)) {
      log(
        "WARN",
        `Lead #${lead.id} extracted_price=${reply.extracted_price} not found in last in-messages, skipping deal creation`,
      );
      // Отправим обычный ответ если body есть
    } else {
      log("INFO", `Lead #${lead.id} mentioned price: ${reply.extracted_price}`);
      const summary = await ai.summarizeDialogue(lead, history);
      const tx = db.transaction(() => {
        const dealResult = stmts.insertDeal.run(
          lead.id,
          project.id,
          reply.extracted_price,
          summary,
          now,
        );
        stmts.updateLeadStage.run("deal_pending", now, lead.id);
        return dealResult.lastInsertRowid;
      });
      const dealId = tx();
      workerState.stats.deals++;
      log(
        "INFO",
        `Deal #${dealId} created for lead #${lead.id}, awaiting admin approval`,
      );
      if (adminBot.isReady()) {
        const deal = db.prepare("SELECT * FROM deals WHERE id = ?").get(dealId);
        adminBot
          .sendDealNotification(deal)
          .catch((e) => log("ERR", "Bot notify failed: " + e.message));
      }
      return;
    }
  }

  if (reply.flag === "consultation_needed" && reply.consultation_question) {
    log("INFO", `Lead #${lead.id} needs admin consultation`);
    const consultResult = db
      .prepare(
        `INSERT INTO consultations (lead_id, question, context, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
      )
      .run(
        lead.id,
        reply.consultation_question,
        JSON.stringify(history.slice(-3)),
        now,
      );
    if (adminBot.isReady()) {
      const consultation = db
        .prepare("SELECT * FROM consultations WHERE id = ?")
        .get(consultResult.lastInsertRowid);
      adminBot
        .askConsultation(consultation, lead)
        .catch((e) => log("ERR", "Bot notify failed: " + e.message));
    }
    return;
  }

  if (reply.body) {
    // Review mode: в очередь вместо отправки
    if (isReviewMode()) {
      const firstMeta = history[0] ? safeJsonParse(history[0].metadata) : {};
      const recipient =
        dialogue.channel === "email"
          ? parseEmailList(lead.email)[0]
          : parseTelegramHandle(lead.telegram);
      queueReply({
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
      // Update lead dialogue_stage based on AI-detected stage
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
        stmts.updateLeadStage.run(newStage, new Date().toISOString(), lead.id);
        log(
          "INFO",
          `Lead #${lead.id} stage: ${reply.conversation_stage} → ${newStage}`,
        );
      }
      return;
    }

    let metadata = {};
    let trackingId = null;
    if (dialogue.channel === "email") {
      trackingId = generateTrackingId();
      const trackingPixelUrl = buildTrackingPixelUrl(
        currentWorkspaceId,
        trackingId,
      );
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
      incrementDailyCount("email");
    } else if (dialogue.channel === "telegram") {
      const tgResult = await sendTelegramBound(
        dialogue.id,
        parseTelegramHandle(lead.telegram),
        reply.body,
      );
      metadata = {
        tg_message_id: tgResult.messageId,
        chat_id: tgResult.chatId,
        account_id: tgResult.accountId,
      };
      incrementDailyCount("telegram");
    }

    const tx = db.transaction(() => {
      stmts.insertMessage.run({
        dialogue_id: dialogue.id,
        direction: "out",
        sender: "agent",
        content: reply.body,
        metadata: JSON.stringify(metadata),
        created_at: now,
        tracking_id: trackingId,
      });
      stmts.incrementDialogueMsgCount.run(dialogue.id);
      stmts.updateLeadStage.run("negotiating", now, lead.id);
    });
    tx();
    log("INFO", `Sent ${dialogue.channel} reply to lead #${lead.id}`);
  }
}

// ─── Process decided deals (admin approved/rejected) ───────────────

async function processDecidedDeals() {
  if (!workerState.running) return;
  const decided = db
    .prepare(
      `
    SELECT d.*, l.id AS l_id, l.dialogue_stage, l.email, l.telegram, l.channel_name
    FROM deals d JOIN leads l ON l.id = d.lead_id
    WHERE d.admin_decision IS NOT NULL AND l.dialogue_stage = 'deal_pending'
  `,
    )
    .all();

  if (decided.length === 0) return;

  const project = stmts.getActiveProject.get();
  if (!project) return;

  for (const deal of decided) {
    try {
      const lead = stmts.getLead.get(deal.l_id);
      const dialogue = db
        .prepare(
          `SELECT * FROM dialogues WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(lead.id);
      if (!dialogue) continue;

      const history = stmts.listMessagesByDialogue.all(dialogue.id);

      // admin directive передаём в system prompt (не в history)
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
      );
      const now = new Date().toISOString();
      const finalStage =
        deal.admin_decision === "approved" ? "won" : "negotiating";

      // Review mode → в очередь
      if (isReviewMode()) {
        if (hasActivePendingReply(lead.id, dialogue.id)) continue;
        const recipient =
          dialogue.channel === "email"
            ? parseEmailList(lead.email)[0]
            : parseTelegramHandle(lead.telegram);
        queueReply({
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

      let metadata = {};
      let trackingId = null;
      if (dialogue.channel === "email") {
        trackingId = generateTrackingId();
        const trackingPixelUrl = buildTrackingPixelUrl(
          currentWorkspaceId,
          trackingId,
        );
        const lastOut = history.filter((m) => m.direction === "out").pop();
        const replyToHeader = lastOut
          ? safeJsonParse(lastOut.metadata).resend_id
          : null;
        const result = await email.sendEmail({
          to: parseEmailList(lead.email)[0],
          subject: reply.subject || "Re: ",
          body: reply.body,
          replyToHeader,
          leadId: lead.id,
          trackingPixelUrl,
        });
        metadata = { subject: reply.subject, resend_id: result.id };
        incrementDailyCount("email");
      } else if (dialogue.channel === "telegram") {
        const tgResult = await sendTelegramBound(
          dialogue.id,
          parseTelegramHandle(lead.telegram),
          reply.body,
        );
        metadata = {
          tg_message_id: tgResult.messageId,
          chat_id: tgResult.chatId,
          account_id: tgResult.accountId,
        };
        incrementDailyCount("telegram");
      }

      const tx = db.transaction(() => {
        stmts.insertMessage.run({
          dialogue_id: dialogue.id,
          direction: "out",
          sender: "agent",
          content: reply.body,
          metadata: JSON.stringify({
            ...metadata,
            deal_decision: deal.admin_decision,
          }),
          created_at: now,
          tracking_id: trackingId,
        });
        stmts.incrementDialogueMsgCount.run(dialogue.id);
        stmts.updateLeadStage.run(finalStage, now, lead.id);
      });
      tx();
      log(
        "INFO",
        `Deal #${deal.id} executed (${deal.admin_decision}) for lead #${lead.id}`,
      );
    } catch (e) {
      log(
        "ERR",
        `processDecidedDeals failed for deal #${deal.id}: ${e.message}`,
      );
      workerState.stats.errors++;
    }
  }
}

// ─── Process answered consultations ─────────────────────────────────

async function processAnsweredConsultations() {
  if (!workerState.running) return;
  const answered = db
    .prepare(
      `
    SELECT * FROM consultations WHERE status = 'answered' AND admin_response IS NOT NULL
    AND id NOT IN (SELECT COALESCE(json_extract(metadata,'$.consultation_id'),0) FROM messages WHERE metadata LIKE '%consultation_id%')
  `,
    )
    .all();

  if (answered.length === 0) return;
  const project = stmts.getActiveProject.get();
  if (!project) return;

  for (const consultation of answered) {
    try {
      if (!consultation.lead_id) continue;
      const lead = stmts.getLead.get(consultation.lead_id);
      if (!lead) continue;
      const dialogue = db
        .prepare(
          `SELECT * FROM dialogues WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(lead.id);
      if (!dialogue) continue;

      const history = stmts.listMessagesByDialogue.all(dialogue.id);
      const adminDirective = `ОТВЕТ АДМИНА НА ТВОЙ ВОПРОС "${consultation.question}": ${consultation.admin_response}\nИспользуй эту информацию чтобы продолжить диалог с блогером. Не упоминай что консультировался с админом.`;

      const reply = await ai.generateReply(
        lead,
        project,
        history,
        dialogue.channel,
        adminDirective,
      );
      const now = new Date().toISOString();

      // Review mode → очередь
      if (isReviewMode()) {
        if (hasActivePendingReply(lead.id, dialogue.id)) continue;
        const recipient =
          dialogue.channel === "email"
            ? parseEmailList(lead.email)[0]
            : parseTelegramHandle(lead.telegram);
        queueReply({
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
        const trackingPixelUrl = buildTrackingPixelUrl(
          currentWorkspaceId,
          trackingId,
        );
        const lastOut = history.filter((m) => m.direction === "out").pop();
        const replyToHeader = lastOut
          ? safeJsonParse(lastOut.metadata).resend_id
          : null;
        const result = await email.sendEmail({
          to: parseEmailList(lead.email)[0],
          subject: reply.subject || "Re: ",
          body: reply.body,
          replyToHeader,
          trackingPixelUrl,
        });
        metadata.subject = reply.subject;
        metadata.resend_id = result.id;
        incrementDailyCount("email");
      } else if (dialogue.channel === "telegram") {
        const tgResult = await sendTelegramBound(
          dialogue.id,
          parseTelegramHandle(lead.telegram),
          reply.body,
        );
        metadata.tg_message_id = tgResult.messageId;
        metadata.chat_id = tgResult.chatId;
        metadata.account_id = tgResult.accountId;
        incrementDailyCount("telegram");
      }

      const tx = db.transaction(() => {
        stmts.insertMessage.run({
          dialogue_id: dialogue.id,
          direction: "out",
          sender: "agent",
          content: reply.body,
          metadata: JSON.stringify(metadata),
          created_at: now,
          tracking_id: trackingId,
        });
        stmts.incrementDialogueMsgCount.run(dialogue.id);
      });
      tx();
      log(
        "INFO",
        `Consultation #${consultation.id} processed for lead #${lead.id}`,
      );
    } catch (e) {
      log("ERR", `processAnsweredConsultations failed: ${e.message}`);
    }
  }
}

// ─── Process approved pending replies (Review mode) ────────────────

// Атомарный "клайм" записи: переводит approved → sending только если она ещё approved.
// Защита от race между interval-тиком и setImmediate(processApprovedQueue) при approve.
const _claimPendingReplyStmt = db.prepare(
  `UPDATE pending_replies SET status = 'sending' WHERE id = ? AND status = 'approved'`,
);
const _unclaimPendingReplyStmt = db.prepare(
  `UPDATE pending_replies SET status = 'approved' WHERE id = ? AND status = 'sending'`,
);

async function processApprovedQueue(workspaceId) {
  if (isProcessingApproved) return;
  isProcessingApproved = true;

  // Swap to workspace DB if provided
  const savedStmts = stmts;
  const savedDb = db;
  const savedWsId = currentWorkspaceId;
  if (workspaceId) {
    const ws = dbModule.getDb(workspaceId);
    stmts = ws.stmts;
    db = ws.db;
    currentWorkspaceId = workspaceId;
  }

  try {
    const items = stmts.pickApprovedPendingReplies.all(MAX_REPLIES_PER_TICK);
    if (items.length === 0) return;

    // Sequential — чтобы daily cap не пробивался при параллельной отправке.
    for (const item of items) {
      // Timer check: if send_after is set and not yet reached — skip
      if (item.send_after && new Date(item.send_after) > new Date()) {
        continue;
      }
      // Клайм: только один процесс/тик получит эту запись.
      const claim = db
        .prepare(
          `UPDATE pending_replies SET status = 'sending' WHERE id = ? AND status = 'approved'`,
        )
        .run(item.id);
      if (claim.changes !== 1) continue; // взял другой тик — пропускаем
      try {
        await sendApprovedPendingReply(item);
      } catch (e) {
        log("ERR", `pending_reply #${item.id} send failed: ${e.message}`);
        // Не оставляем висеть в 'sending' — помечаем failed
        try {
          stmts.markPendingReplyFailed.run(e.message.slice(0, 500), item.id);
        } catch {
          db.prepare(
            `UPDATE pending_replies SET status = 'approved' WHERE id = ?`,
          ).run(item.id);
        }
        workerState.lastError = e.message;
        workerState.stats.errors++;
      }
    }
  } finally {
    isProcessingApproved = false;
    if (workspaceId) {
      stmts = savedStmts;
      db = savedDb;
      currentWorkspaceId = savedWsId;
    }
  }
}

async function sendApprovedPendingReply(item) {
  const ctx = safeJsonParse(item.context);
  const body =
    item.edited_body && item.edited_body.trim() ? item.edited_body : item.body;
  const subject =
    item.edited_subject && item.edited_subject.trim()
      ? item.edited_subject
      : item.subject;
  const lead = stmts.getLead.get(item.lead_id);
  if (!lead) throw new Error("lead not found");

  // Opted-out check (GDPR)
  if (lead.opted_out) throw new Error("lead opted out");

  const now = new Date().toISOString();
  const daily = getDailyCounts();
  if (item.channel === "email" && daily.sent_email >= DAILY_CAP_EMAIL)
    throw new Error("daily email cap reached");
  if (item.channel === "telegram" && daily.sent_tg >= DAILY_CAP_TG)
    throw new Error("daily tg cap reached");

  // Для reply нужен history для replyToHeader
  let replyToHeader = null;
  if (item.dialogue_id && item.channel === "email") {
    const lastOut = db
      .prepare(
        `SELECT * FROM messages WHERE dialogue_id = ? AND direction='out' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(item.dialogue_id);
    if (lastOut) replyToHeader = safeJsonParse(lastOut.metadata).resend_id;
  }

  // Для TG: аккаунт-владелец диалога (или выбранный, если привязки ещё нет).
  let tgAccountId = null;
  if (item.channel === "telegram") {
    if (item.dialogue_id) {
      const d = stmts.getDialogue.get(item.dialogue_id);
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
    db.prepare(
      `INSERT INTO dry_run_log (created_at, lead_id, channel, subject, body, would_send_to) VALUES (?,?,?,?,?,?)`,
    ).run(
      now,
      item.lead_id,
      item.channel,
      subject || null,
      body,
      item.recipient,
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
    const trackingPixelUrl = buildTrackingPixelUrl(
      currentWorkspaceId,
      trackingId,
    );
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

  // Post-send транзакция: зависит от типа
  const type = ctx.type;
  const tx = db.transaction(() => {
    if (type === "initial") {
      const dlgResult = stmts.insertDialogue.run(
        lead.id,
        item.channel,
        externalId,
        now,
      );
      if (item.channel === "telegram" && tgAccountId != null)
        stmts.setDialogueAccount.run(tgAccountId, dlgResult.lastInsertRowid);
      stmts.insertMessage.run({
        dialogue_id: dlgResult.lastInsertRowid,
        direction: "out",
        sender: "agent",
        content: body,
        metadata: JSON.stringify({ ...sendMeta, pending_reply_id: item.id }),
        created_at: now,
        tracking_id: trackingId,
      });
      stmts.incrementDialogueMsgCount.run(dlgResult.lastInsertRowid);
      stmts.updateLeadStage.run("awaiting_reply", now, lead.id);
      stmts.updateLeadStatus.run("in_work", now, lead.id);
      if (ctx.project_id)
        stmts.updateLeadProject.run(ctx.project_id, now, lead.id);
      stmts.unlockLead.run(lead.id);
    } else if (
      type === "reply" ||
      type === "deal_accept" ||
      type === "consultation_answer"
    ) {
      const metaExtra = {};
      if (type === "deal_accept") metaExtra.deal_decision = ctx.deal_decision;
      if (type === "consultation_answer")
        metaExtra.consultation_id = ctx.consultation_id;
      if (
        item.channel === "telegram" &&
        tgAccountId != null &&
        item.dialogue_id
      )
        stmts.setDialogueAccount.run(tgAccountId, item.dialogue_id);
      stmts.insertMessage.run({
        dialogue_id: item.dialogue_id,
        direction: "out",
        sender: "agent",
        content: body,
        metadata: JSON.stringify({
          ...sendMeta,
          ...metaExtra,
          pending_reply_id: item.id,
        }),
        created_at: now,
        tracking_id: trackingId,
      });
      stmts.incrementDialogueMsgCount.run(item.dialogue_id);
      if (ctx.next_stage)
        stmts.updateLeadStage.run(ctx.next_stage, now, lead.id);
    }
    stmts.markPendingReplySent.run(now, item.id);
  });
  tx();

  incrementDailyCount(item.channel);
  workerState.stats.sent++;
  log(
    "INFO",
    `[review] Sent approved pending_reply #${item.id} (${type}) to lead #${lead.id} via ${item.channel}`,
  );
}

// ─── Follow-up sequences ────────────────────────────────────────────

function getFollowUpConfig() {
  const row = stmts.getSetting.get("followup");
  let cfg = {};
  if (row && row.value) {
    try {
      cfg = JSON.parse(row.value);
    } catch {}
  }
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

let isProcessingFollowUps = false;

async function processFollowUps() {
  if (!workerState.running) return;
  const cfg = getFollowUpConfig();
  if (!cfg.enabled) return;
  if (isProcessingFollowUps) return;
  isProcessingFollowUps = true;

  try {
    const cutoffMs = Date.now() - cfg.delay_days * 24 * 3600 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();
    const candidates = stmts.pickFollowUpCandidates.all({
      max_attempts: cfg.max_attempts,
      limit: 20,
      cutoff,
    });
    if (candidates.length === 0) return;

    const project = stmts.getActiveProject.get();
    if (!project) return;

    for (const row of candidates) {
      try {
        if (!row.last_out_at) continue;

        const lead = stmts.getLead.get(row.id);
        const history = stmts.listMessagesByDialogue.all(row.dlg_id);
        const attempt = (lead.followup_attempts || 0) + 1;

        log(
          "INFO",
          `Follow-up #${attempt} for lead #${lead.id} (silent since ${row.last_out_at})`,
        );
        const reply = await ai.generateFollowUp(
          lead,
          project,
          history,
          row.dlg_channel,
          attempt,
        );
        if (!reply || !reply.body) {
          log("WARN", `Follow-up empty for lead #${lead.id}`);
          continue;
        }

        const now = new Date().toISOString();
        const recipient =
          row.dlg_channel === "email"
            ? parseEmailList(lead.email)[0]
            : parseTelegramHandle(lead.telegram);

        // Review mode → в очередь
        if (isReviewMode()) {
          if (hasActivePendingReply(lead.id, row.dlg_id)) continue;
          const followupStageReview =
            attempt >= 2 ? "followup_2" : "followup_1";
          queueReply({
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
          stmts.incrementLeadFollowUp.run(now, now, lead.id);
          continue;
        }

        // Прямая отправка
        const daily = getDailyCounts();
        if (row.dlg_channel === "email" && daily.sent_email >= DAILY_CAP_EMAIL)
          continue;
        if (row.dlg_channel === "telegram" && daily.sent_tg >= DAILY_CAP_TG)
          continue;

        let metadata = { followup: attempt };
        let trackingId = null;
        if (row.dlg_channel === "email") {
          trackingId = generateTrackingId();
          const trackingPixelUrl = buildTrackingPixelUrl(
            currentWorkspaceId,
            trackingId,
          );
          const lastOut = history.filter((m) => m.direction === "out").pop();
          const replyToHeader = lastOut
            ? safeJsonParse(lastOut.metadata).resend_id
            : null;
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
          incrementDailyCount("email");
        } else if (row.dlg_channel === "telegram") {
          const result = await sendTelegramBound(
            row.dlg_id,
            recipient,
            reply.body,
          );
          metadata.tg_message_id = result.messageId;
          metadata.chat_id = result.chatId;
          metadata.account_id = result.accountId;
          incrementDailyCount("telegram");
        }

        const followupStage = attempt >= 2 ? "followup_2" : "followup_1";
        const tx = db.transaction(() => {
          stmts.insertMessage.run({
            dialogue_id: row.dlg_id,
            direction: "out",
            sender: "agent",
            content: reply.body,
            metadata: JSON.stringify(metadata),
            created_at: now,
            tracking_id: trackingId,
          });
          stmts.incrementDialogueMsgCount.run(row.dlg_id);
          stmts.incrementLeadFollowUp.run(now, now, lead.id);
          stmts.updateLeadStage.run(followupStage, now, lead.id);
        });
        tx();
        workerState.stats.sent++;
        log(
          "INFO",
          `Follow-up #${attempt} sent to lead #${lead.id} via ${row.dlg_channel}`,
        );
      } catch (e) {
        log("ERR", `Follow-up failed for lead #${row.id}: ${e.message}`);
        workerState.stats.errors++;
      }
    }
  } finally {
    isProcessingFollowUps = false;
  }
}

// Вызывается из routes/pending-replies при reject, чтобы освободить лида
function onPendingReplyRejected(pendingReplyId) {
  try {
    const item = stmts.getPendingReply.get(pendingReplyId);
    if (!item) return;
    const ctx = safeJsonParse(item.context);
    // Для initial → освободить лид чтобы воркер перегенерил pitch (или оставил ручное решение)
    if (ctx.type === "initial") {
      db.prepare(
        `UPDATE leads SET locked_until = NULL, dialogue_stage = 'not_contacted', lead_status = 'ready', updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), item.lead_id);
    }
  } catch (e) {
    log("ERR", "onPendingReplyRejected: " + e.message);
  }
}

// ─── Telegram incoming handler ──────────────────────────────────────

// Найти TG-лида по username/chat_id ВО ВСЕХ воркспейсах (TG-аккаунты общие,
// а лиды разнесены по ws-БД). Возвращает { lead, ws, wsId } или null.
function findTgLeadAcrossWorkspaces(username, chatId) {
  const fs = require("fs");
  const path = require("path");
  const dataDir = path.join(__dirname, "..", "data");
  let files = [];
  try {
    files = fs
      .readdirSync(dataDir)
      .filter((f) => f.startsWith("ws-") && f.endsWith(".db"));
  } catch {
    return null;
  }
  const needle = username
    ? String(username).toLowerCase().trim().replace(/^@/, "")
    : null;

  for (const file of files) {
    const wsId = file.replace(/^ws-/, "").replace(/\.db$/, "");
    const ws = dbModule.getDb(wsId);
    // 1) точный матч по username (несколько хендлов через ;/,)
    if (needle) {
      const cands = ws.db
        .prepare(
          `SELECT * FROM leads WHERE telegram IS NOT NULL AND telegram != ''`,
        )
        .all();
      for (const l of cands) {
        const handles = String(l.telegram)
          .split(/[;,]/)
          .map((h) => h.trim().replace(/^@/, "").toLowerCase())
          .filter(Boolean);
        if (handles.includes(needle)) return { lead: l, ws, wsId };
      }
    }
    // 2) fallback — по chat_id (external_thread_id или metadata)
    if (chatId) {
      const row = ws.db
        .prepare(
          `SELECT l.* FROM dialogues d
           JOIN messages m ON m.dialogue_id = d.id
           JOIN leads l ON l.id = d.lead_id
           WHERE d.channel = 'telegram' AND (d.external_thread_id = ? OR m.metadata LIKE ?)
           LIMIT 1`,
        )
        .get(String(chatId), '%"chat_id":"' + chatId + '"%');
      if (row) return { lead: row, ws, wsId };
    }
  }
  return null;
}

async function handleIncomingTelegram(msg) {
  if (!msg.username && !msg.senderId) return;

  // Матч лида по всем воркспейсам (TG общий, лиды разнесены).
  const match = findTgLeadAcrossWorkspaces(msg.username, msg.chatId);
  if (!match) {
    log(
      "WARN",
      `TG message from @${msg.username || msg.senderId} — no matching lead (любой ws)`,
    );
    return;
  }

  // Свопаем контекст БД на воркспейс лида (как processInbox для email).
  const savedStmts = stmts;
  const savedDb = db;
  const savedWsId = currentWorkspaceId;
  stmts = match.ws.stmts;
  db = match.ws.db;
  currentWorkspaceId = match.wsId;
  try {
    const lead = match.lead;
    let dialogue = stmts.getDialogueByLead.get(lead.id, "telegram");

    // Дедуп: если сообщение с таким tg_message_id уже записано у лида — пропускаем
    // (защита от двойного приёма live-листенером и catch-up fetchRecentIncoming).
    if (msg.messageId && dialogue) {
      const dup = db
        .prepare(
          `SELECT m.id FROM messages m
           JOIN dialogues d ON d.id = m.dialogue_id
           WHERE d.lead_id = ? AND d.channel = 'telegram'
             AND m.direction = 'in' AND m.metadata LIKE ? LIMIT 1`,
        )
        .get(lead.id, '%"tg_message_id":"' + msg.messageId + '"%');
      if (dup) {
        log(
          "INFO",
          `TG incoming dup skipped (lead #${lead.id}, msg ${msg.messageId})`,
        );
        return;
      }
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      if (!dialogue) {
        const r = stmts.insertDialogue.run(
          lead.id,
          "telegram",
          msg.chatId,
          now,
        );
        dialogue = {
          id: r.lastInsertRowid,
          lead_id: lead.id,
          channel: "telegram",
          account_id: null,
        };
      }
      // Привязка диалога к аккаунту, ПОЛУЧИВШЕМУ входящее (или backfill).
      if (msg.accountId != null && dialogue.account_id == null) {
        stmts.setDialogueAccount.run(msg.accountId, dialogue.id);
        dialogue.account_id = msg.accountId;
      }
      stmts.insertMessage.run({
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
      stmts.incrementDialogueMsgCount.run(dialogue.id);
      stmts.updateLeadStage.run("replied", now, lead.id);
    });
    tx();

    workerState.stats.replied++;
    log(
      "INFO",
      `TG reply from @${msg.username} (lead #${lead.id}, ws: ${match.wsId})`,
    );

    await generatePendingReplies();
  } catch (e) {
    log("ERR", `TG handler failed: ${e.message}`);
  } finally {
    stmts = savedStmts;
    db = savedDb;
    currentWorkspaceId = savedWsId;
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
    `Outreach worker started (TG ready: ${tg.isReady()}, AdminBot: ${adminBot.isReady()}, ReviewMode: ${isReviewMode()})`,
  );
  setTimeout(processOutreachQueue, 1000);
  setTimeout(processInbox, 3000);
  setTimeout(processDecidedDeals, 5000);
  setTimeout(processApprovedQueue, 7000);
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

function status() {
  const counts = stmts.countLeads.get();
  const daily = getDailyCounts();
  const pending = stmts.countPendingReplies.get("pending");
  return {
    running: workerState.running,
    lastTick: workerState.lastTick,
    lastError: workerState.lastError,
    stats: workerState.stats,
    queue: { ready: counts.ready || 0, in_work: counts.in_work || 0 },
    daily: {
      sent_email: daily.sent_email,
      sent_tg: daily.sent_tg,
      cap_email: DAILY_CAP_EMAIL,
      cap_tg: DAILY_CAP_TG,
    },
    review_mode: isReviewMode(),
    pending_review: pending?.n || 0,
  };
}

module.exports = {
  start,
  stop,
  status,
  getLogs,
  processOutreachQueue,
  processInbox,
  processApprovedQueue,
  processFollowUps,
  runLeadNow,
  runLeadsNow,
  channelAvailability,
  existingOutChannels,
  handleIncomingTelegram,
  enableTelegramListener,
  onPendingReplyRejected,
  isReviewMode,
  getFollowUpConfig,
};
