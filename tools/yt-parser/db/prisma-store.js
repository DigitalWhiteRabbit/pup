/**
 * prisma-store.js — слой ЧТЕНИЯ yt-parser поверх единого Prisma-Postgres PUP.
 * Шаг 3.1 унификации БД (см. ../../_docs/TZ-marketing-db-unification.md, Батч 3).
 *
 * Зеркалит read-поверхность db/database.js (те же имена и форма строк:
 * snake_case-поля, legacy-статусы lowercase, даты ISO-строками), НО:
 *   - функции async (Prisma), у всех первый аргумент — PUP workspaceId (cuid);
 *   - id сущностей — cuid-строки (не int).
 *
 * НЕ подключён к routes/worker — это произойдёт на Шаге 3.2.
 */
const { PrismaClient } = require("./generated/prisma");
const { encrypt, decrypt } = require("./crypto");

const prisma = new PrismaClient();

// ─── enum → legacy (зеркало карт из scripts/migrate-ytparser-to-prisma.ts) ───

const LEAD_STATUS_TO_LEGACY = {
  PENDING: "pending",
  READY: "ready",
  IN_WORK: "in_work",
  DONE: "done",
  REJECTED: "rejected",
};

const DIALOGUE_STAGE_TO_LEGACY = {
  NOT_CONTACTED: "not_contacted",
  QUEUED: "queued",
  AWAITING_REVIEW: "awaiting_review",
  CONTACTED: "contacted",
  AWAITING_REPLY: "awaiting_reply",
  FOLLOWUP_1: "followup_1",
  FOLLOWUP_2: "followup_2",
  REPLIED: "replied",
  NEGOTIATING: "negotiating",
  DEAL_PENDING: "deal_pending",
  WON: "won",
  LOST: "lost",
  MOVED_TO_TG: "moved_to_tg",
};

const DIRECTION_TO_LEGACY = { IN: "in", OUT: "out" };

const SENDER_TO_LEGACY = {
  AGENT: "agent",
  ADMIN: "admin",
  EXTERNAL: "blogger",
};

// В SQLite admin_decision до решения — NULL (см. listPendingDeals: WHERE admin_decision IS NULL)
const DEAL_DECISION_TO_LEGACY = {
  PENDING: null,
  APPROVED: "approved",
  REJECTED: "rejected",
};

const PENDING_STATUS_TO_LEGACY = {
  PENDING: "pending",
  APPROVED: "approved",
  SENDING: "sending",
  REJECTED: "rejected",
  SENT: "sent",
  FAILED: "failed",
};

function legacyEnum(map, value) {
  if (value == null) return null;
  return map[value] !== undefined ? map[value] : value;
}

// ─── legacy → enum (для WRITE; зеркало карт миграционного скрипта) ───────────

function invert(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) if (v != null) out[v] = k;
  return out;
}

const LEAD_STATUS_FROM_LEGACY = invert(LEAD_STATUS_TO_LEGACY); // ready→READY…
const DIALOGUE_STAGE_FROM_LEGACY = invert(DIALOGUE_STAGE_TO_LEGACY);
const DIRECTION_FROM_LEGACY = invert(DIRECTION_TO_LEGACY); // in→IN
const SENDER_FROM_LEGACY = invert(SENDER_TO_LEGACY); // blogger→EXTERNAL
const PENDING_STATUS_FROM_LEGACY = invert(PENDING_STATUS_TO_LEGACY);

function toEnum(map, value, fallback) {
  const key = (value == null ? "" : String(value)).trim().toLowerCase();
  if (key === "") return fallback;
  return map[key] || fallback;
}

// deal: legacy null/'' → PENDING
function dealDecisionToEnum(value) {
  const key = (value == null ? "" : String(value)).trim().toLowerCase();
  if (key === "approved") return "APPROVED";
  if (key === "rejected") return "REJECTED";
  return "PENDING";
}

// даты из legacy-кода: ISO-строка | ms-число | Date | null
function toDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  const d = new Date(typeof v === "number" ? v : String(v));
  return isNaN(d.getTime()) ? null : d;
}

// ─── утилиты формы ───────────────────────────────────────────────────────────

function iso(d) {
  return d == null ? null : d.toISOString();
}

function int01(b) {
  return b ? 1 : 0;
}

// ─── мапперы строк (Prisma → старая форма database.js) ──────────────────────

function leadToLegacy(l) {
  if (!l) return l;
  return {
    id: l.id,
    channel_id: l.channelId,
    channel_name: l.channelName,
    channel_url: l.channelUrl,
    thumbnail: l.thumbnail,
    country: l.country,
    subscribers: l.subscribers,
    avg_views: l.avgViews,
    engagement_rate: l.engagementRate,
    email: l.email,
    telegram: l.telegram,
    whatsapp: l.whatsapp,
    raw_contacts: l.rawContacts,
    keyword: l.keyword,
    lead_status: legacyEnum(LEAD_STATUS_TO_LEGACY, l.leadStatus),
    dialogue_stage: legacyEnum(DIALOGUE_STAGE_TO_LEGACY, l.dialogueStage),
    project_id: l.projectId,
    agreed_price: l.agreedPrice,
    notes: l.notes,
    manual_contacts: l.manualContacts,
    created_at: iso(l.createdAt),
    updated_at: iso(l.updatedAt),
    locked_until: l.lockedUntil ? l.lockedUntil.getTime() : null,
    content_summary: l.contentSummary,
    followup_attempts: l.followupAttempts,
    last_followup_at: iso(l.lastFollowupAt),
    last_videos_json: l.lastVideosJson,
    channel_about_text: l.channelAboutText,
    channel_tags: l.channelTags,
    top_playlists_json: l.topPlaylistsJson,
    channel_age_days: l.channelAgeDays,
    channel_language: l.channelLanguage,
    main_category: l.mainCategory,
    er_normalized: l.erNormalized,
    er_flags: l.erFlags,
    enriched_at: iso(l.enrichedAt),
    is_deep_summary: int01(l.isDeepSummary),
    lead_score: l.leadScore,
    score_breakdown: l.scoreBreakdown,
    shorts_count: l.shortsCount,
    shorts_ratio: l.shortsRatio,
    shorts_avg_views: l.shortsAvgViews,
    long_avg_views: l.longAvgViews,
    posting_frequency: l.postingFrequency,
    scored_at: iso(l.scoredAt),
    opted_out: int01(l.optedOut),
    tg_draft: l.tgDraft,
    tg_draft_ru: l.tgDraftRu,
    // analysis_* — из связи MktLeadAnalysis (1:1), плоско как в SQLite
    analysis_verdict: l.analysis ? l.analysis.verdict : null,
    analysis_recommendation: l.analysis ? l.analysis.recommendation : null,
    analysis_score: l.analysis ? l.analysis.score : null,
    analysis_reasoning: l.analysis ? l.analysis.reasoning : null,
    analysis_metrics: l.analysis ? l.analysis.metrics : null,
    analyzed_at: l.analysis ? iso(l.analysis.analyzedAt) : null,
  };
}

function dialogueToLegacy(d) {
  if (!d) return d;
  return {
    id: d.id,
    lead_id: d.leadId,
    channel: d.channel,
    external_thread_id: d.externalThreadId,
    created_at: iso(d.createdAt),
    // в SQLite account_id — INTEGER (id строки tg_account); в Prisma хранится строкой
    account_id:
      d.accountId == null
        ? null
        : /^\d+$/.test(d.accountId)
          ? Number(d.accountId)
          : d.accountId,
  };
}

function messageToLegacy(m) {
  if (!m) return m;
  return {
    id: m.id,
    dialogue_id: m.dialogueId,
    direction: legacyEnum(DIRECTION_TO_LEGACY, m.direction),
    sender: legacyEnum(SENDER_TO_LEGACY, m.sender),
    content: m.content,
    metadata: m.metadata,
    created_at: iso(m.createdAt),
    content_ru: m.contentRu,
    opened_at: iso(m.openedAt),
    open_count: m.openCount,
    open_ip: null, // в Prisma не переносилось (решение ТЗ: open_ip/open_ua не мигрируем)
    open_ua: null,
    tracking_id: m.trackingId,
    resend_id: m.resendId,
    delivery_status: m.deliveryStatus,
    delivered_at: iso(m.deliveredAt),
    bounced_at: iso(m.bouncedAt),
  };
}

function projectToLegacy(p) {
  if (!p) return p;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    unique_selling_points: p.uniqueSellingPoints,
    target_audience: p.targetAudience,
    budget_min: p.budgetMin,
    budget_max: p.budgetMax,
    ad_formats: p.adFormats,
    language: p.language,
    is_active: int01(p.isActive),
    created_at: iso(p.createdAt),
    updated_at: iso(p.updatedAt),
    ideal_channel_profile: p.idealChannelProfile,
    bad_fit_examples: p.badFitExamples,
    proof_points: p.proofPoints,
    value_prop_short: p.valuePropShort,
    signature: p.signature,
    cta_text: p.ctaText,
    cta_link: p.ctaLink,
    creator_economics: p.creatorEconomics,
    tone_of_voice: p.toneOfVoice,
    stop_words: p.stopWords,
    agent_persona: p.agentPersona,
    sample_pitches: p.samplePitches,
    content_red_flags: p.contentRedFlags,
    admin_directive: p.adminDirective,
    system_prompt: p.systemPrompt,
    pitch_temperature: p.pitchTemperature,
    subject_pool: p.subjectPool,
    reply_delay_min: p.replyDelayMin,
    reply_delay_max: p.replyDelayMax,
  };
}

function pendingReplyToLegacy(pr) {
  if (!pr) return pr;
  return {
    id: pr.id,
    lead_id: pr.leadId,
    dialogue_id: pr.dialogueId,
    channel: pr.channel,
    recipient: pr.recipient,
    subject: pr.subject,
    body: pr.body,
    context: pr.context,
    status: legacyEnum(PENDING_STATUS_TO_LEGACY, pr.status),
    edited_body: pr.editedBody,
    edited_subject: pr.editedSubject,
    admin_notes: pr.adminNotes,
    created_at: iso(pr.createdAt),
    decided_at: iso(pr.decidedAt),
    sent_at: iso(pr.sentAt),
    send_after: iso(pr.sendAfter),
  };
}

function dealToLegacy(d) {
  if (!d) return d;
  return {
    id: d.id,
    lead_id: d.leadId,
    project_id: d.projectId,
    proposed_price: d.proposedPrice,
    agent_summary: d.agentSummary,
    admin_decision: legacyEnum(DEAL_DECISION_TO_LEGACY, d.adminDecision),
    admin_notes: d.adminNotes,
    created_at: iso(d.createdAt),
    decided_at: iso(d.decidedAt),
  };
}

// ─── Leads ───────────────────────────────────────────────────────────────────

// зеркало stmts.listLeads.all({status, stage, limit, offset})
async function listLeads(workspaceId, { status, stage, limit, offset }) {
  const rows = await prisma.mktLead.findMany({
    where: {
      workspaceId,
      ...(status ? { leadStatus: status.toUpperCase() } : {}),
      ...(stage ? { dialogueStage: stage.toUpperCase() } : {}),
    },
    include: { analysis: true },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
  return rows.map(leadToLegacy);
}

// зеркало stmts.countLeads.get()
async function countLeads(workspaceId) {
  const groups = await prisma.mktLead.groupBy({
    by: ["leadStatus"],
    where: { workspaceId },
    _count: { _all: true },
  });
  const out = {
    total: 0,
    pending: 0,
    ready: 0,
    in_work: 0,
    done: 0,
    rejected: 0,
  };
  for (const g of groups) {
    const n = g._count._all;
    out.total += n;
    const key = legacyEnum(LEAD_STATUS_TO_LEGACY, g.leadStatus);
    if (key in out) out[key] = n;
  }
  return out;
}

// зеркало stmts.getLead.get(id)
async function getLead(workspaceId, id) {
  const l = await prisma.mktLead.findFirst({
    where: { id, workspaceId },
    include: { analysis: true },
  });
  return leadToLegacy(l);
}

// ─── Dialogues & Messages ────────────────────────────────────────────────────

// зеркало stmts.getDialogue.get(id)
async function getDialogue(workspaceId, id) {
  const d = await prisma.mktDialogue.findFirst({
    where: { id, lead: { workspaceId } },
  });
  return dialogueToLegacy(d);
}

// зеркало stmts.listAllDialogues.all() — с превью-полями
async function listAllDialogues(workspaceId) {
  const dialogues = await prisma.mktDialogue.findMany({
    where: { lead: { workspaceId } },
    include: {
      lead: {
        select: {
          channelName: true,
          country: true,
          subscribers: true,
          leadStatus: true,
          dialogueStage: true,
          notes: true,
        },
      },
      // tiebreaker id ASC: SQLite-подзапрос (ORDER BY created_at DESC LIMIT 1)
      // при равных датах отдаёт первую вставленную строку (rowid ASC) — зеркалим
      messages: { orderBy: [{ createdAt: "desc" }, { id: "asc" }] },
    },
  });

  const rows = dialogues.map((d) => {
    const last = d.messages[0] || null;
    const lastOut = d.messages.find((m) => m.direction === "OUT") || null;
    return {
      ...dialogueToLegacy(d),
      channel_name: d.lead.channelName,
      country: d.lead.country,
      subscribers: d.lead.subscribers,
      lead_status: legacyEnum(LEAD_STATUS_TO_LEGACY, d.lead.leadStatus),
      dialogue_stage: legacyEnum(
        DIALOGUE_STAGE_TO_LEGACY,
        d.lead.dialogueStage,
      ),
      notes: d.lead.notes,
      last_message: last ? last.content : null,
      last_message_at: last ? iso(last.createdAt) : null,
      message_count: d.messages.length,
      last_out_opened_at: lastOut ? iso(lastOut.openedAt) : null,
      last_out_open_count: lastOut ? lastOut.openCount : null,
    };
  });

  // ORDER BY last_message_at DESC NULLS LAST, created_at DESC
  rows.sort((a, b) => {
    if (a.last_message_at && b.last_message_at)
      return b.last_message_at.localeCompare(a.last_message_at);
    if (a.last_message_at) return -1;
    if (b.last_message_at) return 1;
    return b.created_at.localeCompare(a.created_at);
  });
  return rows;
}

// зеркало stmts.listMessagesByLead.all(leadId)
async function listMessagesByLead(workspaceId, leadId) {
  const rows = await prisma.mktMessage.findMany({
    where: { dialogue: { leadId, lead: { workspaceId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(messageToLegacy);
}

// зеркало stmts.getLastOutgoingMessageOpen.get(leadId)
async function getLastOutgoingMessageOpen(workspaceId, leadId) {
  const m = await prisma.mktMessage.findFirst({
    where: {
      direction: "OUT",
      dialogue: { leadId, lead: { workspaceId } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], // ties → первая вставленная (как SQLite)
    select: { openedAt: true, openCount: true },
  });
  return m
    ? { opened_at: iso(m.openedAt), open_count: m.openCount }
    : undefined;
}

// ─── Projects ────────────────────────────────────────────────────────────────

// зеркало stmts.listProjects.all()
async function listProjects(workspaceId) {
  const rows = await prisma.mktProject.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(projectToLegacy);
}

// зеркало stmts.getProject.get(id)
async function getProject(workspaceId, id) {
  const p = await prisma.mktProject.findFirst({ where: { id, workspaceId } });
  return projectToLegacy(p);
}

// зеркало stmts.getActiveProject.get()
async function getActiveProject(workspaceId) {
  const p = await prisma.mktProject.findFirst({
    where: { workspaceId, isActive: true },
  });
  return projectToLegacy(p);
}

// ─── Pending replies ─────────────────────────────────────────────────────────

// зеркало stmts.listPendingReplies.all({status, limit, offset}) — c JOIN-полями лида
async function listPendingReplies(workspaceId, { status, limit, offset }) {
  const rows = await prisma.mktPendingReply.findMany({
    where: {
      lead: { workspaceId },
      ...(status ? { status: status.toUpperCase() } : {}),
    },
    include: {
      lead: {
        select: {
          channelName: true,
          country: true,
          subscribers: true,
          channelUrl: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset,
  });
  return rows.map((pr) => ({
    ...pendingReplyToLegacy(pr),
    channel_name: pr.lead ? pr.lead.channelName : null,
    country: pr.lead ? pr.lead.country : null,
    subscribers: pr.lead ? pr.lead.subscribers : null,
    channel_url: pr.lead ? pr.lead.channelUrl : null,
  }));
}

// зеркало stmts.countPendingReplies.get(status) → {n}
async function countPendingReplies(workspaceId, status) {
  const n = await prisma.mktPendingReply.count({
    where: { lead: { workspaceId }, status: status.toUpperCase() },
  });
  return { n };
}

// зеркало stmts.getPendingReply.get(id)
async function getPendingReply(workspaceId, id) {
  const pr = await prisma.mktPendingReply.findFirst({
    where: { id, lead: { workspaceId } },
  });
  return pendingReplyToLegacy(pr);
}

// ─── Deals ───────────────────────────────────────────────────────────────────

// зеркало stmts.listPendingDeals.all() — WHERE admin_decision IS NULL (=PENDING)
async function listPendingDeals(workspaceId) {
  const rows = await prisma.mktDeal.findMany({
    where: { adminDecision: "PENDING", lead: { workspaceId } },
    include: {
      lead: { select: { channelName: true, subscribers: true, country: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((d) => ({
    ...dealToLegacy(d),
    channel_name: d.lead.channelName,
    subscribers: d.lead.subscribers,
    country: d.lead.country,
  }));
}

// ═══ WRITE-слой (Шаг 3.2) — зеркало write-stmts database.js ══════════════════

// ─── Leads: запись ────────────────────────────────────────────────────────────

// зеркало stmts.insertLead.run({...}) — INSERT OR IGNORE по channel_id.
// Возвращает { changes, id } (id лида — созданного или существующего).
async function insertLead(workspaceId, p) {
  const existing = await prisma.mktLead.findUnique({
    where: {
      workspaceId_channelId: { workspaceId, channelId: String(p.channel_id) },
    },
    select: { id: true },
  });
  if (existing) return { changes: 0, id: existing.id };
  const created = await prisma.mktLead.create({
    data: {
      workspaceId,
      channelId: String(p.channel_id),
      channelName: p.channel_name ?? null,
      channelUrl: p.channel_url ?? null,
      thumbnail: p.thumbnail ?? null,
      country: p.country ?? null,
      subscribers: p.subscribers ?? null,
      avgViews: p.avg_views ?? null,
      engagementRate: p.engagement_rate ?? null,
      email: p.email ?? null,
      telegram: p.telegram ?? null,
      whatsapp: p.whatsapp ?? null,
      rawContacts: p.raw_contacts ?? null,
      keyword: p.keyword ?? null,
      leadStatus: "PENDING",
      dialogueStage: "NOT_CONTACTED",
      source: "YOUTUBE",
      createdAt: toDate(p.created_at) ?? undefined,
    },
    select: { id: true },
  });
  return { changes: 1, id: created.id };
}

// зеркало stmts.updateLeadStatus.run(status, updatedAt, id)
async function updateLeadStatus(workspaceId, status, _updatedAt, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { leadStatus: toEnum(LEAD_STATUS_FROM_LEGACY, status, "PENDING") },
  });
}

// зеркало stmts.updateLeadStage.run(stage, updatedAt, id)
async function updateLeadStage(workspaceId, stage, _updatedAt, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: {
      dialogueStage: toEnum(DIALOGUE_STAGE_FROM_LEGACY, stage, "NOT_CONTACTED"),
    },
  });
}

// зеркало stmts.updateLeadProject.run(projectId, updatedAt, id)
async function updateLeadProject(workspaceId, projectId, _updatedAt, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { projectId: projectId || null },
  });
}

// зеркало stmts.updateLeadNotes.run(notes, updatedAt, id)
async function updateLeadNotes(workspaceId, notes, _updatedAt, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { notes: notes ?? null },
  });
}

// Отметить/снять «написал сам» по каналу. Хранится JSON {channel: ISO-date} в manualContacts.
// Возвращает актуальный объект отметок (или null, если лид не найден).
async function setManualContact(workspaceId, id, channel, on) {
  const lead = await prisma.mktLead.findFirst({
    where: { id, workspaceId },
    select: { manualContacts: true },
  });
  if (!lead) return null;
  let obj = {};
  try {
    obj = lead.manualContacts ? JSON.parse(lead.manualContacts) : {};
  } catch {
    obj = {};
  }
  if (on) obj[channel] = new Date().toISOString();
  else delete obj[channel];
  const json = Object.keys(obj).length ? JSON.stringify(obj) : null;
  await prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { manualContacts: json },
  });
  return obj;
}

// зеркало stmts.updateLeadContacts.run({email, telegram, updated_at, id})
async function updateLeadContacts(workspaceId, p) {
  return prisma.mktLead.updateMany({
    where: { id: p.id, workspaceId },
    data: { email: p.email ?? null, telegram: p.telegram ?? null },
  });
}

// зеркало stmts.updateLeadEnrichment.run({...}) — COALESCE-семантика:
// null-параметр НЕ затирает существующее значение.
async function updateLeadEnrichment(workspaceId, p) {
  const data = {};
  const map = {
    last_videos_json: "lastVideosJson",
    channel_about_text: "channelAboutText",
    channel_tags: "channelTags",
    top_playlists_json: "topPlaylistsJson",
    channel_age_days: "channelAgeDays",
    channel_language: "channelLanguage",
    main_category: "mainCategory",
    er_normalized: "erNormalized",
    er_flags: "erFlags",
  };
  for (const [legacy, model] of Object.entries(map)) {
    if (p[legacy] != null) data[model] = p[legacy];
  }
  data.enrichedAt = toDate(p.enriched_at);
  return prisma.mktLead.updateMany({ where: { id: p.id, workspaceId }, data });
}

// зеркало stmts.updateLeadSummary.run(summary, updatedAt, id)
async function updateLeadSummary(workspaceId, summary, _updatedAt, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { contentSummary: summary ?? null },
  });
}

// зеркало stmts.updateLeadSummaryDeep.run(summary, updatedAt, id)
async function updateLeadSummaryDeep(workspaceId, summary, _updatedAt, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { contentSummary: summary ?? null, isDeepSummary: true },
  });
}

// зеркало stmts.lockLead.run(lockedUntilMs, id)
async function lockLead(workspaceId, lockedUntil, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { lockedUntil: toDate(lockedUntil) },
  });
}

// зеркало stmts.unlockLead.run(id)
async function unlockLead(workspaceId, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { lockedUntil: null },
  });
}

// зеркало stmts.incrementLeadFollowUp.run(lastFollowupAt, updatedAt, id)
async function incrementLeadFollowUp(
  workspaceId,
  lastFollowupAt,
  _updatedAt,
  id,
) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: {
      followupAttempts: { increment: 1 },
      lastFollowupAt: toDate(lastFollowupAt),
    },
  });
}

// зеркало inline-запроса (opted_out = 1) — воркспейс-скоупленный вариант
async function markLeadOptedOut(workspaceId, _updatedAt, id) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { optedOut: true },
  });
}

// Публичная отписка (routes/unsubscribe.js): у запроса НЕТ воркспейса — резолвим
// по глобально-уникальному cuid лида (MktLead.id уникален во всех воркспейсах).
// Возвращает { changes } (0 — лид не найден).
async function optOutLeadById(leadId) {
  const r = await prisma.mktLead.updateMany({
    where: { id: leadId },
    data: { optedOut: true },
  });
  return { changes: r.count };
}

// зеркало inline-запроса routes/leads.js (analysis_* поля) → MktLeadAnalysis
async function updateLeadAnalysis(workspaceId, id, a) {
  const lead = await prisma.mktLead.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!lead) return { changes: 0 };
  const data = {
    verdict: a.verdict ?? null,
    recommendation: a.recommendation ?? null,
    score: a.score ?? null,
    reasoning: a.reasoning ?? null,
    metrics:
      a.metrics == null
        ? null
        : typeof a.metrics === "string"
          ? a.metrics
          : JSON.stringify(a.metrics),
    analyzedAt: toDate(a.analyzed_at) ?? new Date(),
  };
  await prisma.mktLeadAnalysis.upsert({
    where: { leadId: id },
    update: data,
    create: { leadId: id, ...data },
  });
  return { changes: 1 };
}

// ─── Dialogues: запись ────────────────────────────────────────────────────────

// зеркало stmts.insertDialogue.run(leadId, channel, threadId, createdAt)
// Возвращает { changes, id } созданного диалога.
async function insertDialogue(
  workspaceId,
  leadId,
  channel,
  externalThreadId,
  createdAt,
) {
  const lead = await prisma.mktLead.findFirst({
    where: { id: leadId, workspaceId },
    select: { id: true },
  });
  if (!lead) return { changes: 0, id: null };
  const d = await prisma.mktDialogue.create({
    data: {
      leadId,
      channel,
      externalThreadId: externalThreadId ?? null,
      createdAt: toDate(createdAt) ?? undefined,
    },
    select: { id: true },
  });
  return { changes: 1, id: d.id };
}

// зеркало stmts.setDialogueAccount.run(accountId, id)
async function setDialogueAccount(workspaceId, accountId, id) {
  return prisma.mktDialogue.updateMany({
    where: { id, lead: { workspaceId } },
    data: { accountId: accountId == null ? null : String(accountId) },
  });
}

// зеркало stmts.updateDialogueThread.run(threadId, id)
async function updateDialogueThread(workspaceId, externalThreadId, id) {
  return prisma.mktDialogue.updateMany({
    where: { id, lead: { workspaceId } },
    data: { externalThreadId },
  });
}

// зеркало stmts.incrementDialogueMsgCount.run(id).
// В Prisma message_count НЕ денормализован (считается из messages) — no-op,
// сигнатура сохранена для drop-in (см. listAllDialogues: message_count живой).
async function incrementDialogueMsgCount(_workspaceId, _id) {
  return { changes: 1 };
}

// ─── Messages: запись ─────────────────────────────────────────────────────────

// зеркало stmts.insertMessage.run({dialogue_id, direction, sender, content, metadata, created_at, tracking_id})
async function insertMessage(workspaceId, p) {
  const d = await prisma.mktDialogue.findFirst({
    where: { id: p.dialogue_id, lead: { workspaceId } },
    select: { id: true },
  });
  if (!d) return { changes: 0, id: null };
  const m = await prisma.mktMessage.create({
    data: {
      dialogueId: p.dialogue_id,
      direction: toEnum(DIRECTION_FROM_LEGACY, p.direction, "IN"),
      sender: toEnum(SENDER_FROM_LEGACY, p.sender, "EXTERNAL"),
      content: p.content ?? "",
      contentRu: p.content_ru ?? null,
      subject: p.subject ?? null,
      metadata: p.metadata ?? null,
      resendId: p.resend_id ?? null,
      trackingId: p.tracking_id ?? null,
      createdAt: toDate(p.created_at) ?? undefined,
    },
    select: { id: true },
  });
  return { changes: 1, id: m.id };
}

// Записать событие доставки Resend (идемпотентно по svixId) и обновить статус письма.
// Возвращает { changes, duplicate }.
async function recordEmailEvent({
  svixId,
  resendId,
  type,
  occurredAt,
  payload,
}) {
  const at = toDate(occurredAt);
  try {
    await prisma.mktEmailEvent.create({
      data: {
        svixId,
        resendId: resendId ?? null,
        type: String(type || ""),
        occurredAt: at ?? undefined,
        payload: payload ?? null,
      },
    });
  } catch (e) {
    if (e && e.code === "P2002") return { changes: 0, duplicate: true };
    throw e;
  }
  if (!resendId) return { changes: 0, duplicate: false };

  // opened → инкремент, дата первого открытия
  if (type === "email.opened") {
    const msg = await prisma.mktMessage.findFirst({
      where: { resendId },
      select: { id: true, openedAt: true },
    });
    if (msg) {
      await prisma.mktMessage.update({
        where: { id: msg.id },
        data: {
          openedAt: msg.openedAt ?? at ?? undefined,
          openCount: { increment: 1 },
        },
      });
      return { changes: 1, duplicate: false };
    }
    return { changes: 0, duplicate: false };
  }

  // Финальные статусы пишем всегда; sent/delayed — только если статус ещё не проставлен,
  // чтобы поздний sent/delayed не затёр delivered/bounced.
  if (type === "email.delivered") {
    // deliveredAt пишем всегда (факт доставки); статус НЕ понижаем с bounced/complained,
    // если такое пришло раньше (порядок вебхуков не гарантирован).
    const r = await prisma.mktMessage.updateMany({
      where: {
        resendId,
        OR: [
          { deliveryStatus: null },
          { deliveryStatus: { notIn: ["bounced", "complained", "delivered"] } },
        ],
      },
      data: { deliveryStatus: "delivered", deliveredAt: at ?? undefined },
    });
    if (r.count === 0) {
      // всё же зафиксировать дату доставки, не трогая финальный статус
      await prisma.mktMessage.updateMany({
        where: { resendId, deliveredAt: null },
        data: { deliveredAt: at ?? undefined },
      });
    }
    return { changes: r.count, duplicate: false };
  }
  if (type === "email.bounced") {
    const r = await prisma.mktMessage.updateMany({
      where: { resendId },
      data: { deliveryStatus: "bounced", bouncedAt: at ?? undefined },
    });
    return { changes: r.count, duplicate: false };
  }
  if (type === "email.complained") {
    const r = await prisma.mktMessage.updateMany({
      where: { resendId },
      data: { deliveryStatus: "complained" },
    });
    return { changes: r.count, duplicate: false };
  }
  if (type === "email.delivery_delayed") {
    const r = await prisma.mktMessage.updateMany({
      where: { resendId, deliveryStatus: null },
      data: { deliveryStatus: "delayed" },
    });
    return { changes: r.count, duplicate: false };
  }
  return { changes: 0, duplicate: false };
}

// зеркало inline-запроса routes/tracking.js: первое открытие + инкремент счётчика
// (open_ip/open_ua в Prisma не переносились — игнорируются)
async function recordMessageOpen(workspaceId, openedAt, _ip, _ua, trackingId) {
  const msg = await prisma.mktMessage.findFirst({
    where: { trackingId, dialogue: { lead: { workspaceId } } },
    select: { id: true, openedAt: true },
  });
  if (!msg) return { changes: 0 };
  await prisma.mktMessage.update({
    where: { id: msg.id },
    data: {
      openedAt: msg.openedAt ?? toDate(openedAt),
      openCount: { increment: 1 },
    },
  });
  return { changes: 1 };
}

// ─── Pending replies: запись ──────────────────────────────────────────────────

// зеркало stmts.insertPendingReply.run({...}) — status='pending'
async function insertPendingReply(workspaceId, p) {
  const lead = await prisma.mktLead.findFirst({
    where: { id: p.lead_id, workspaceId },
    select: { id: true },
  });
  if (!lead) return { changes: 0, id: null };
  const pr = await prisma.mktPendingReply.create({
    data: {
      leadId: p.lead_id,
      dialogueId: p.dialogue_id ?? null,
      channel: p.channel,
      recipient: p.recipient ?? "",
      subject: p.subject ?? null,
      body: p.body ?? "",
      context: p.context ?? null,
      status: "PENDING",
      createdAt: toDate(p.created_at) ?? undefined,
    },
    select: { id: true },
  });
  return { changes: 1, id: pr.id };
}

// зеркало stmts.approvePendingReply.run(editedBody, editedSubject, adminNotes, decidedAt, id)
async function approvePendingReply(
  workspaceId,
  editedBody,
  editedSubject,
  adminNotes,
  decidedAt,
  id,
) {
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId } },
    data: {
      status: "APPROVED",
      editedBody: editedBody ?? null,
      editedSubject: editedSubject ?? null,
      adminNotes: adminNotes ?? null,
      decidedAt: toDate(decidedAt),
    },
  });
}

// зеркало stmts.rejectPendingReply.run(adminNotes, decidedAt, id)
async function rejectPendingReply(workspaceId, adminNotes, decidedAt, id) {
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId } },
    data: {
      status: "REJECTED",
      adminNotes: adminNotes ?? null,
      decidedAt: toDate(decidedAt),
    },
  });
}

// зеркало stmts.markPendingReplySent.run(sentAt, id)
async function markPendingReplySent(workspaceId, sentAt, id) {
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId } },
    data: { status: "SENT", sentAt: toDate(sentAt) },
  });
}

// зеркало stmts.markPendingReplyFailed.run(adminNotes, id)
async function markPendingReplyFailed(workspaceId, adminNotes, id) {
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId } },
    data: { status: "FAILED", adminNotes: adminNotes ?? null },
  });
}

// зеркало inline-запросов routes/pending-replies.js (send_after = ? | NULL)
async function setPendingReplySendAfter(workspaceId, sendAfter, id) {
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId } },
    data: { sendAfter: toDate(sendAfter) },
  });
}

// зеркало inline routes/pending-replies.js: message по metadata pending_reply_id
async function findMessageOpenByPendingReplyId(workspaceId, pendingReplyId) {
  const m = await prisma.mktMessage.findFirst({
    where: {
      direction: "OUT",
      metadata: { contains: String(pendingReplyId) },
      dialogue: { lead: { workspaceId } },
    },
    select: { openedAt: true, openCount: true },
  });
  return m
    ? { opened_at: iso(m.openedAt), open_count: m.openCount }
    : undefined;
}

// зеркало inline: DELETE FROM pending_replies WHERE id = ?
async function deletePendingReply(workspaceId, id) {
  return prisma.mktPendingReply.deleteMany({
    where: { id, lead: { workspaceId } },
  });
}

// зеркало inline: purge sent/rejected/failed старше cutoff
async function purgeOldPendingReplies(workspaceId, cutoffIso) {
  const r = await prisma.mktPendingReply.deleteMany({
    where: {
      lead: { workspaceId },
      status: { in: ["SENT", "REJECTED", "FAILED"] },
      createdAt: { lt: toDate(cutoffIso) },
    },
  });
  return { changes: r.count };
}

// зеркало inline (regenerate): UPDATE subject/body
async function updatePendingReplyContent(workspaceId, id, { subject, body }) {
  const data = {};
  if (subject !== undefined) data.subject = subject;
  if (body !== undefined) data.body = body;
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId } },
    data,
  });
}

// зеркало inline (retry): approved + сброс таймера/ошибки + правки текста
async function retryPendingReply(
  workspaceId,
  id,
  editedBody,
  editedSubject,
  decidedAt,
) {
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId } },
    data: {
      status: "APPROVED",
      sendAfter: null,
      adminNotes: null,
      editedBody: editedBody ?? null,
      editedSubject: editedSubject ?? null,
      decidedAt: toDate(decidedAt),
    },
  });
}

// зеркало stmts.listMessagesByDialogue.all(dialogueId)
async function listMessagesByDialogue(workspaceId, dialogueId) {
  const rows = await prisma.mktMessage.findMany({
    where: { dialogueId, dialogue: { lead: { workspaceId } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(messageToLegacy);
}

// зеркало inline: SELECT id FROM dialogues WHERE lead_id = ? LIMIT 1
async function getAnyDialogueByLead(workspaceId, leadId) {
  const d = await prisma.mktDialogue.findFirst({
    where: { leadId, lead: { workspaceId } },
    select: { id: true },
  });
  return d || undefined;
}

// зеркало inline (history): кэш перевода в messages.content_ru
async function setMessageContentRu(workspaceId, messageId, contentRu) {
  return prisma.mktMessage.updateMany({
    where: { id: messageId, dialogue: { lead: { workspaceId } } },
    data: { contentRu },
  });
}

// зеркало inline routes/agent.js (stats по dialogue_stage; несуществующие в enum
// legacy-бакеты ('deal_closed', 'in_work'…) вклада не дают — как и в SQLite)
async function getAgentLeadStats(workspaceId) {
  const groups = await prisma.mktLead.groupBy({
    by: ["dialogueStage"],
    where: { workspaceId },
    _count: { _all: true },
  });
  const count = (stages) =>
    groups
      .filter((g) => stages.includes(g.dialogueStage))
      .reduce((s, g) => s + g._count._all, 0);
  const totalAll = groups.reduce((s, g) => s + g._count._all, 0);
  return {
    total: totalAll - count(["NOT_CONTACTED"]),
    completed: count(["DEAL_PENDING"]),
    active: count([
      "NEGOTIATING",
      "AWAITING_REPLY",
      "FOLLOWUP_1",
      "FOLLOWUP_2",
      "QUEUED",
      "REPLIED",
    ]),
    pending: count(["AWAITING_REVIEW"]),
  };
}

// ─── Deals: запись ────────────────────────────────────────────────────────────

// зеркало stmts.insertDeal.run(leadId, projectId, proposedPrice, agentSummary, createdAt)
async function insertDeal(
  workspaceId,
  leadId,
  projectId,
  proposedPrice,
  agentSummary,
  createdAt,
) {
  const lead = await prisma.mktLead.findFirst({
    where: { id: leadId, workspaceId },
    select: { id: true },
  });
  if (!lead) return { changes: 0, id: null };
  const d = await prisma.mktDeal.create({
    data: {
      leadId,
      projectId,
      proposedPrice: proposedPrice ?? null,
      agentSummary: agentSummary ?? null,
      adminDecision: "PENDING",
      createdAt: toDate(createdAt) ?? undefined,
    },
    select: { id: true },
  });
  return { changes: 1, id: d.id };
}

// зеркало stmts.decideDeal.run(decision, adminNotes, decidedAt, id) — decision legacy
async function decideDeal(workspaceId, decision, adminNotes, decidedAt, id) {
  return prisma.mktDeal.updateMany({
    where: { id, lead: { workspaceId } },
    data: {
      adminDecision: dealDecisionToEnum(decision),
      adminNotes: adminNotes ?? null,
      decidedAt: toDate(decidedAt),
    },
  });
}

// ─── Daily counters ───────────────────────────────────────────────────────────

// зеркало stmts.upsertDailyCounters.run({date, sent_email, sent_tg, ai_*}) —
// инкрементальный upsert по (workspaceId, dateKey)
async function upsertDailyCounters(workspaceId, p) {
  const inc = {
    emailsSent: p.sent_email ?? 0,
    tgSent: p.sent_tg ?? 0,
    tokensIn: p.ai_input_tokens ?? 0,
    tokensOut: p.ai_output_tokens ?? 0,
    tokensCacheRead: p.ai_cache_read ?? 0,
    tokensCacheCreate: p.ai_cache_creation ?? 0,
  };
  return prisma.mktDailyCounter.upsert({
    where: { workspaceId_dateKey: { workspaceId, dateKey: p.date } },
    update: {
      emailsSent: { increment: inc.emailsSent },
      tgSent: { increment: inc.tgSent },
      tokensIn: { increment: inc.tokensIn },
      tokensOut: { increment: inc.tokensOut },
      tokensCacheRead: { increment: inc.tokensCacheRead },
      tokensCacheCreate: { increment: inc.tokensCacheCreate },
    },
    create: { workspaceId, dateKey: p.date, ...inc },
  });
}

// ─── Projects: запись ─────────────────────────────────────────────────────────

// зеркало stmts.insertProject.run({...}). Возвращает { changes, id }.
async function insertProject(workspaceId, p) {
  const created = await prisma.mktProject.create({
    data: {
      workspaceId,
      name: p.name,
      description: p.description ?? "",
      uniqueSellingPoints: p.unique_selling_points ?? null,
      targetAudience: p.target_audience ?? null,
      budgetMin: p.budget_min ?? null,
      budgetMax: p.budget_max ?? null,
      adFormats: p.ad_formats ?? null,
      language: p.language ?? "ru",
      isActive: !!p.is_active,
      idealChannelProfile: p.ideal_channel_profile ?? null,
      badFitExamples: p.bad_fit_examples ?? null,
      proofPoints: p.proof_points ?? null,
      valuePropShort: p.value_prop_short ?? null,
      signature: p.signature ?? null,
      ctaText: p.cta_text ?? null,
      ctaLink: p.cta_link ?? null,
      creatorEconomics: p.creator_economics ?? null,
      toneOfVoice: p.tone_of_voice ?? null,
      stopWords: p.stop_words ?? null,
      agentPersona: p.agent_persona ?? null,
      createdAt: toDate(p.created_at) ?? undefined,
    },
    select: { id: true },
  });
  return { changes: 1, id: created.id };
}

// зеркало stmts.updateProject.run({...})
async function updateProject(workspaceId, p) {
  return prisma.mktProject.updateMany({
    where: { id: p.id, workspaceId },
    data: {
      name: p.name,
      description: p.description ?? "",
      uniqueSellingPoints: p.unique_selling_points ?? null,
      targetAudience: p.target_audience ?? null,
      budgetMin: p.budget_min ?? null,
      budgetMax: p.budget_max ?? null,
      adFormats: p.ad_formats ?? null,
      language: p.language ?? "ru",
      idealChannelProfile: p.ideal_channel_profile ?? null,
      badFitExamples: p.bad_fit_examples ?? null,
      proofPoints: p.proof_points ?? null,
      valuePropShort: p.value_prop_short ?? null,
      signature: p.signature ?? null,
      ctaText: p.cta_text ?? null,
      ctaLink: p.cta_link ?? null,
      creatorEconomics: p.creator_economics ?? null,
      toneOfVoice: p.tone_of_voice ?? null,
      stopWords: p.stop_words ?? null,
      agentPersona: p.agent_persona ?? null,
      adminDirective: p.admin_directive ?? null,
      systemPrompt: p.system_prompt ?? null,
      replyDelayMin: p.reply_delay_min ?? null,
      replyDelayMax: p.reply_delay_max ?? null,
    },
  });
}

// зеркало stmts.deactivateAllProjects.run()
async function deactivateAllProjects(workspaceId) {
  return prisma.mktProject.updateMany({
    where: { workspaceId },
    data: { isActive: false },
  });
}

// зеркало stmts.activateProject.run(updatedAt, id) — single-active инвариант
// обеспечен транзакцией (deactivate всех остальных + activate целевого).
async function activateProject(workspaceId, _updatedAt, id) {
  return prisma.$transaction([
    prisma.mktProject.updateMany({
      where: { workspaceId, NOT: { id } },
      data: { isActive: false },
    }),
    prisma.mktProject.updateMany({
      where: { id, workspaceId },
      data: { isActive: true },
    }),
  ]);
}

// зеркало stmts.deleteProject.run(id)
async function deleteProject(workspaceId, id) {
  return prisma.mktProject.deleteMany({ where: { id, workspaceId } });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

// зеркало stmts.upsertSetting.run(key, value, updatedAt) → MktSetting (workspaceId, key)
async function upsertSetting(workspaceId, key, value, _updatedAt) {
  return prisma.mktSetting.upsert({
    where: { workspaceId_key: { workspaceId, key } },
    update: { value: String(value) },
    create: { workspaceId, key, value: String(value) },
  });
}

// зеркало stmts.getSetting.get(key) → { value } | undefined
async function getSetting(workspaceId, key) {
  const row = await prisma.mktSetting.findUnique({
    where: { workspaceId_key: { workspaceId, key } },
    select: { value: true },
  });
  return row || undefined;
}

// ─── Consultations ────────────────────────────────────────────────────────────

// зеркало inline-запроса routes/consultations.js (JOIN с лидом, фильтр по status)
async function listConsultations(workspaceId, status) {
  const rows = await prisma.mktConsultation.findMany({
    where: {
      ...(status ? { status } : {}),
      OR: [{ lead: { workspaceId } }, { leadId: null }],
    },
    include: {
      lead: { select: { channelName: true, channelUrl: true } },
    },
    orderBy: { createdAt: "desc" },
    ...(status ? {} : { take: 100 }),
  });
  return rows.map((c) => ({
    id: c.id,
    lead_id: c.leadId,
    question: c.question,
    context: c.context,
    admin_response: c.adminResponse,
    status: c.status,
    created_at: iso(c.createdAt),
    answered_at: iso(c.answeredAt),
    channel_name: c.lead ? c.lead.channelName : null,
    channel_url: c.lead ? c.lead.channelUrl : null,
  }));
}

// зеркало inline-запроса routes/consultations.js (/:id/answer)
async function answerConsultation(workspaceId, adminResponse, answeredAt, id) {
  return prisma.mktConsultation.updateMany({
    where: {
      id,
      OR: [{ lead: { workspaceId } }, { leadId: null }],
    },
    data: {
      adminResponse: adminResponse ?? null,
      status: "answered",
      answeredAt: toDate(answeredAt),
    },
  });
}

// зеркало inline-запросов routes/deals.js: все сделки либо по решению
// (decision — legacy 'approved'/'rejected'; null → все)
async function listDealsByDecision(workspaceId, decision) {
  const rows = await prisma.mktDeal.findMany({
    where: {
      lead: { workspaceId },
      ...(decision ? { adminDecision: dealDecisionToEnum(decision) } : {}),
    },
    include: {
      lead: {
        select: {
          channelName: true,
          subscribers: true,
          country: true,
          channelUrl: true,
          thumbnail: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((d) => ({
    ...dealToLegacy(d),
    channel_name: d.lead.channelName,
    subscribers: d.lead.subscribers,
    country: d.lead.country,
    channel_url: d.lead.channelUrl,
    thumbnail: d.lead.thumbnail,
  }));
}

// ─── TG-аккаунты пула (MktTgAccount) с AES-256-GCM шифрованием секретов ──────

// Чувствительные поля (ciphertext at rest); на чтение — дешифруются.
const TG_SECRET_FIELDS = ["session", "two_fa", "api_hash", "proxy_pass"];

function tgAccountToLegacy(a, { decryptSecrets = false } = {}) {
  if (!a) return a;
  const out = {
    id: a.id,
    label: a.label,
    phone: a.phone,
    api_id: a.apiId,
    api_hash: a.apiHash,
    session: a.session,
    proxy_type: a.proxyType,
    proxy_host: a.proxyHost,
    proxy_port: a.proxyPort,
    proxy_user: a.proxyUser,
    proxy_pass: a.proxyPass,
    status: a.status,
    first_used_at: a.firstUsedAt,
    sent_today: a.sentToday,
    sent_today_date: a.sentTodayDate,
    daily_cap: a.dailyCap,
    flood_until: a.floodUntil == null ? null : Number(a.floodUntil),
    last_sent_at: a.lastSentAt,
    two_fa: a.twoFa,
    user_id: a.userId,
    device_model: a.deviceModel,
    system_version: a.systemVersion,
    app_version: a.appVersion,
    lang_code: a.langCode,
    system_lang_code: a.systemLangCode,
    source: a.source,
    first_name: a.firstName,
    last_name: a.lastName,
    username: a.username,
    metadata: a.metadata,
    created_at: iso(a.createdAt),
    updated_at: iso(a.updatedAt),
  };
  if (decryptSecrets) {
    for (const f of TG_SECRET_FIELDS) {
      if (out[f] != null) out[f] = decrypt(out[f]);
    }
  }
  return out;
}

// snake_case данные → Prisma-data с шифрованием секретов (только переданные поля).
function tgAccountToPrismaData(data) {
  const map = {
    label: "label",
    phone: "phone",
    api_id: "apiId",
    proxy_type: "proxyType",
    proxy_host: "proxyHost",
    proxy_port: "proxyPort",
    proxy_user: "proxyUser",
    status: "status",
    first_used_at: "firstUsedAt",
    sent_today: "sentToday",
    sent_today_date: "sentTodayDate",
    daily_cap: "dailyCap",
    last_sent_at: "lastSentAt",
    user_id: "userId",
    device_model: "deviceModel",
    system_version: "systemVersion",
    app_version: "appVersion",
    lang_code: "langCode",
    system_lang_code: "systemLangCode",
    source: "source",
    first_name: "firstName",
    last_name: "lastName",
    username: "username",
    metadata: "metadata",
  };
  const out = {};
  for (const [snake, col] of Object.entries(map)) {
    if (data[snake] !== undefined) out[col] = data[snake];
  }
  // секреты — шифруем
  if (data.session !== undefined)
    out.session = data.session == null ? null : encrypt(data.session);
  if (data.two_fa !== undefined)
    out.twoFa = data.two_fa == null ? null : encrypt(data.two_fa);
  if (data.api_hash !== undefined)
    out.apiHash = data.api_hash == null ? null : encrypt(data.api_hash);
  if (data.proxy_pass !== undefined)
    out.proxyPass = data.proxy_pass == null ? null : encrypt(data.proxy_pass);
  // flood_until — BigInt-совместимо
  if (data.flood_until !== undefined)
    out.floodUntil = data.flood_until == null ? null : BigInt(data.flood_until);
  return out;
}

// Список аккаунтов воркспейса (движку нужен plaintext session → дешифруем).
async function listTgAccounts(workspaceId) {
  const rows = await prisma.mktTgAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((a) => tgAccountToLegacy(a, { decryptSecrets: true }));
}

async function getTgAccount(workspaceId, id) {
  const a = await prisma.mktTgAccount.findFirst({ where: { id, workspaceId } });
  return tgAccountToLegacy(a, { decryptSecrets: true });
}

async function createTgAccount(workspaceId, data) {
  const a = await prisma.mktTgAccount.create({
    data: { workspaceId, ...tgAccountToPrismaData(data) },
    select: { id: true },
  });
  return { id: a.id };
}

async function updateTgAccount(workspaceId, id, fields) {
  return prisma.mktTgAccount.updateMany({
    where: { id, workspaceId },
    data: tgAccountToPrismaData(fields),
  });
}

async function deleteTgAccount(workspaceId, id) {
  return prisma.mktTgAccount.deleteMany({ where: { id, workspaceId } });
}

// ── ws-agnostic ридеры (глобальный пул движка, 3.3c-4b; id — глобальный cuid) ──
// Аккаунт по id без ws-скоупа (движок не имеет workspaceId).
async function getTgAccountById(id) {
  const a = await prisma.mktTgAccount.findUnique({ where: { id } });
  return tgAccountToLegacy(a, { decryptSecrets: true });
}
// Все active-аккаунты по всем воркспейсам (для загрузки пула в 4b).
async function listAllActiveTgAccounts() {
  const rows = await prisma.mktTgAccount.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((a) => tgAccountToLegacy(a, { decryptSecrets: true }));
}

// ── ws-agnostic писатели движка (по глобальному cuid; зеркало ws-agnostic ридеров) ──
async function updateTgAccountById(id, fields) {
  return prisma.mktTgAccount.update({
    where: { id },
    data: tgAccountToPrismaData(fields),
  });
}
async function setTgAccountStatusById(id, status, floodUntil = undefined) {
  const data = { status };
  if (floodUntil !== undefined)
    data.floodUntil = floodUntil == null ? null : BigInt(floodUntil);
  return prisma.mktTgAccount.update({ where: { id }, data });
}
// Учёт отправки (зеркало recordTgAccountSend): read-modify-write инкремента.
async function recordTgAccountSend(id, dateKey, nowIso) {
  const a = await prisma.mktTgAccount.findUnique({
    where: { id },
    select: { sentToday: true, sentTodayDate: true, firstUsedAt: true },
  });
  if (!a) return null;
  const sentToday = a.sentTodayDate === dateKey ? (a.sentToday || 0) + 1 : 1;
  return prisma.mktTgAccount.update({
    where: { id },
    data: {
      sentToday,
      sentTodayDate: dateKey,
      lastSentAt: nowIso,
      firstUsedAt: a.firstUsedAt || nowIso,
    },
  });
}

// Статус/флуд (зеркало setTgAccountStatus / setTgAccountFlood).
async function setTgAccountStatus(
  workspaceId,
  id,
  status,
  floodUntil = undefined,
) {
  const data = { status };
  if (floodUntil !== undefined)
    data.floodUntil = floodUntil == null ? null : BigInt(floodUntil);
  return prisma.mktTgAccount.updateMany({ where: { id, workspaceId }, data });
}

// ─── Worker: перечисление воркспейсов + атомарный claim лида ─────────────────

// Воркспейсы с активным проектом (замена файлового скана ws-*.db в воркере).
async function listActiveWorkspaceIds() {
  const rows = await prisma.mktProject.findMany({
    where: { isActive: true },
    select: { workspaceId: true },
    distinct: ["workspaceId"],
  });
  return rows.map((r) => r.workspaceId);
}

// Атомарный pick+lock следующего лида для исходящей рассылки.
// Зеркало stmts.pickNextLeadForOutreach + lockLead, но БЕЗ гонки: claim делается
// условным updateMany (WHERE id + lock истёк) и принимается только при count===1.
// Заменяет sync-транзакцию better-sqlite3.
async function claimNextOutreachLead(workspaceId, lockDurationMs) {
  const now = Date.now();
  const hasEmail = { AND: [{ email: { not: null } }, { email: { not: "" } }] };
  const hasTg = {
    AND: [{ telegram: { not: null } }, { telegram: { not: "" } }],
  };
  const lockFree = {
    OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date(now) } }],
  };
  const candidates = await prisma.mktLead.findMany({
    where: {
      workspaceId,
      leadStatus: "READY",
      dialogueStage: "NOT_CONTACTED",
      optedOut: false,
      AND: [{ OR: [hasEmail, hasTg] }, lockFree],
    },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true },
  });
  const lockTarget = new Date(now + lockDurationMs);
  for (const c of candidates) {
    // Условный claim: совпадёт ровно у одного воркера; остальным count===0.
    const claim = await prisma.mktLead.updateMany({
      where: {
        id: c.id,
        workspaceId,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date(now) } }],
      },
      data: { lockedUntil: lockTarget },
    });
    if (claim.count === 1) {
      return getLead(workspaceId, c.id); // legacy-форма
    }
  }
  return null;
}

// Чтение дневных счётчиков (зеркало getDailyCounts воркера).
async function getDailyCounts(workspaceId, dateKey) {
  const row = await prisma.mktDailyCounter.findUnique({
    where: { workspaceId_dateKey: { workspaceId, dateKey } },
    select: { emailsSent: true, tgSent: true },
  });
  return { sent_email: row?.emailsSent || 0, sent_tg: row?.tgSent || 0 };
}

// Есть ли активная (pending/approved) очередь по каналу (зеркало hasPendingForChannel).
async function hasPendingForChannel(workspaceId, leadId, channel) {
  const row = await prisma.mktPendingReply.findFirst({
    where: {
      leadId,
      lead: { workspaceId },
      channel,
      status: { in: ["PENDING", "APPROVED"] },
    },
    select: { id: true },
  });
  return !!row;
}

// Универсальная запись произвольных enrichment-полей лида (snake_case → Prisma).
// Используется store-путём воркера для персиста computeEnrichment(lead).
const LEAD_FIELD_MAP = {
  channel_about_text: "channelAboutText",
  channel_tags: "channelTags",
  main_category: "mainCategory",
  channel_language: "channelLanguage",
  last_videos_json: "lastVideosJson",
  top_playlists_json: "topPlaylistsJson",
  channel_age_days: "channelAgeDays",
  er_normalized: "erNormalized",
  er_flags: "erFlags",
  email: "email",
  telegram: "telegram",
  country: "country",
  raw_contacts: "rawContacts",
  content_summary: "contentSummary",
  enriched_at: "enrichedAt",
};
async function updateLeadFields(workspaceId, id, fields) {
  const data = {};
  for (const [snake, val] of Object.entries(fields)) {
    const col = LEAD_FIELD_MAP[snake];
    if (!col) continue;
    data[col] = col === "enrichedAt" ? toDate(val) : val;
  }
  if (Object.keys(data).length === 0) return { count: 0 };
  return prisma.mktLead.updateMany({ where: { id, workspaceId }, data });
}

// Последний диалог лида (опц. по каналу) — зеркало getDialogueByLead / inline.
async function getLatestDialogueByLead(workspaceId, leadId, channel = null) {
  const d = await prisma.mktDialogue.findFirst({
    where: { leadId, lead: { workspaceId }, ...(channel ? { channel } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return dialogueToLegacy(d);
}

// Глобальный (по всем воркспейсам) матчинг входящего письма к лиду+диалогу:
// сначала по reply-заголовкам (message.metadata.resend_id), затем по email.
// Возвращает { lead(legacy), dialogue(legacy)|null, wsId } или null.
async function findReplyMatch(fromAddr, inReplyTo, references) {
  // 1) reply-заголовки → resend_id в metadata исходящего сообщения
  const ids = new Set();
  const extract = (s) => {
    if (s) for (const m of String(s).matchAll(/<([^>]+)>/g)) ids.add(m[1]);
  };
  extract(inReplyTo);
  extract(references);
  for (const rid of ids) {
    const msg = await prisma.mktMessage.findFirst({
      where: { resendId: rid },
      include: { dialogue: { include: { lead: true } } },
    });
    if (msg && msg.dialogue && msg.dialogue.lead) {
      return {
        lead: leadToLegacy(msg.dialogue.lead),
        dialogue: dialogueToLegacy(msg.dialogue),
        wsId: msg.dialogue.lead.workspaceId,
      };
    }
  }
  // 2) по email-адресу (MktLeadEmail → лид), затем последний email-диалог
  if (fromAddr) {
    const needle = String(fromAddr).toLowerCase().trim();
    const le = await prisma.mktLeadEmail.findFirst({
      where: { email: needle },
      include: { lead: true },
    });
    if (le && le.lead) {
      const dlg = await prisma.mktDialogue.findFirst({
        where: { leadId: le.lead.id, channel: "email" },
        orderBy: { createdAt: "desc" },
      });
      return {
        lead: leadToLegacy(le.lead),
        dialogue: dlg ? dialogueToLegacy(dlg) : null,
        wsId: le.lead.workspaceId,
      };
    }
  }
  return null;
}

// Глобальный (по всем ws) матчинг входящего TG к лиду+диалогу (зеркало
// findReplyMatch для email; TG-аккаунты общие, лиды разнесены по ws).
async function findTgLeadMatch(username, chatId) {
  const needle = username
    ? String(username).toLowerCase().trim().replace(/^@/, "")
    : null;
  if (needle) {
    const leads = await prisma.mktLead.findMany({
      where: { telegram: { not: null }, NOT: { telegram: "" } },
    });
    for (const l of leads) {
      const handles = String(l.telegram)
        .split(/[;,]/)
        .map((h) => h.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean);
      if (handles.includes(needle)) {
        const dlg = await prisma.mktDialogue.findFirst({
          where: { leadId: l.id, channel: "telegram" },
          orderBy: { createdAt: "desc" },
        });
        return {
          lead: leadToLegacy(l),
          dialogue: dlg ? dialogueToLegacy(dlg) : null,
          wsId: l.workspaceId,
        };
      }
    }
  }
  if (chatId) {
    const dlg = await prisma.mktDialogue.findFirst({
      where: { channel: "telegram", externalThreadId: String(chatId) },
      include: { lead: true },
    });
    if (dlg && dlg.lead)
      return {
        lead: leadToLegacy(dlg.lead),
        dialogue: dialogueToLegacy(dlg),
        wsId: dlg.lead.workspaceId,
      };
    const msg = await prisma.mktMessage.findFirst({
      where: {
        dialogue: { channel: "telegram" },
        metadata: { contains: `"chat_id":"${chatId}"` },
      },
      include: { dialogue: { include: { lead: true } } },
    });
    if (msg && msg.dialogue && msg.dialogue.lead)
      return {
        lead: leadToLegacy(msg.dialogue.lead),
        dialogue: dialogueToLegacy(msg.dialogue),
        wsId: msg.dialogue.lead.workspaceId,
      };
  }
  return null;
}

// Дедуп входящего TG по tg_message_id (защита от double-приёма live+catch-up).
async function tgIncomingExists(workspaceId, leadId, tgMessageId) {
  const m = await prisma.mktMessage.findFirst({
    where: {
      direction: "IN",
      metadata: { contains: `"tg_message_id":"${tgMessageId}"` },
      dialogue: { leadId, channel: "telegram", lead: { workspaceId } },
    },
    select: { id: true },
  });
  return !!m;
}

// account_id диалога (для sendTelegramBound: тот же аккаунт ведёт диалог).
async function getDialogueAccountId(workspaceId, dialogueId) {
  const d = await prisma.mktDialogue.findFirst({
    where: { id: dialogueId, lead: { workspaceId } },
    select: { accountId: true },
  });
  return d ? d.accountId : null;
}

// ── admin-bot: ws-agnostic (бот глобальный, аккаунт по cuid) ──
async function listAllPendingDeals() {
  const rows = await prisma.mktDeal.findMany({
    where: { adminDecision: "PENDING" },
    include: {
      lead: {
        select: {
          channelName: true,
          subscribers: true,
          country: true,
          channelUrl: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((d) => ({
    ...dealToLegacy(d),
    channel_name: d.lead.channelName,
    subscribers: d.lead.subscribers,
    country: d.lead.country,
    channel_url: d.lead.channelUrl,
  }));
}
async function decideDealById(id, decision, notes, decidedAt) {
  return prisma.mktDeal.update({
    where: { id },
    data: {
      adminDecision: dealDecisionToEnum(decision),
      adminNotes: notes ?? null,
      decidedAt: toDate(decidedAt),
    },
  });
}
async function getLeadById(id) {
  const l = await prisma.mktLead.findUnique({
    where: { id },
    include: { analysis: true },
  });
  return leadToLegacy(l);
}
async function answerConsultationById(id, response, answeredAt) {
  return prisma.mktConsultation.update({
    where: { id },
    data: {
      adminResponse: response,
      status: "answered",
      answeredAt: toDate(answeredAt),
    },
  });
}
async function countAllLeadsByStatus() {
  const groups = await prisma.mktLead.groupBy({
    by: ["leadStatus"],
    _count: { _all: true },
  });
  const out = {
    total: 0,
    pending: 0,
    ready: 0,
    in_work: 0,
    done: 0,
    rejected: 0,
  };
  for (const g of groups) {
    const n = g._count._all;
    out.total += n;
    const key = legacyEnum(LEAD_STATUS_TO_LEGACY, g.leadStatus);
    if (key in out) out[key] = n;
  }
  return out;
}
async function countAllPendingConsultations() {
  return prisma.mktConsultation.count({ where: { status: "pending" } });
}
async function countAllPendingDeals() {
  return prisma.mktDeal.count({ where: { adminDecision: "PENDING" } });
}
// health (public, ws-agnostic): pending-replies по статусу во всех воркспейсах.
async function countAllPendingReplies(status) {
  const enumStatus =
    PENDING_STATUS_FROM_LEGACY[status] || String(status).toUpperCase();
  return prisma.mktPendingReply.count({ where: { status: enumStatus } });
}
// /cost: дневные счётчики, агрегированные по dateKey по всем воркспейсам (legacy-форма).
async function listAllDailyCounters(limit) {
  const rows = await prisma.mktDailyCounter.findMany({
    orderBy: { dateKey: "desc" },
  });
  const byDate = new Map();
  for (const r of rows) {
    const cur = byDate.get(r.dateKey) || {
      date: r.dateKey,
      ai_input_tokens: 0,
      ai_output_tokens: 0,
      ai_cache_read: 0,
      ai_cache_creation: 0,
      sent_email: 0,
      sent_tg: 0,
    };
    cur.ai_input_tokens += r.tokensIn || 0;
    cur.ai_output_tokens += r.tokensOut || 0;
    cur.ai_cache_read += r.tokensCacheRead || 0;
    cur.ai_cache_creation += r.tokensCacheCreate || 0;
    cur.sent_email += r.emailsSent || 0;
    cur.sent_tg += r.tgSent || 0;
    byDate.set(r.dateKey, cur);
  }
  return [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

// Лиды с новым входящим без ответа (зеркало pickLeadsWithNewReplies).
// Условие SQL воспроизводим в JS: status ready/in_work, stage не финальный,
// есть IN-сообщение новее последнего OUT, и нет rejected-pending новее посл. IN.
async function pickLeadsWithNewReplies(workspaceId) {
  const leads = await prisma.mktLead.findMany({
    where: {
      workspaceId,
      leadStatus: { in: ["READY", "IN_WORK"] },
      dialogueStage: { notIn: ["WON", "LOST", "DEAL_PENDING", "MOVED_TO_TG"] },
    },
    include: {
      dialogues: { include: { messages: true } },
      pendingReplies: { where: { status: "REJECTED" } },
    },
  });
  const result = [];
  for (const l of leads) {
    let hasNewIn = false;
    for (const d of l.dialogues) {
      const lastOut = d.messages
        .filter((m) => m.direction === "OUT")
        .reduce(
          (max, m) => (!max || m.createdAt > max ? m.createdAt : max),
          null,
        );
      const lastIn = d.messages
        .filter((m) => m.direction === "IN")
        .reduce(
          (max, m) => (!max || m.createdAt > max ? m.createdAt : max),
          null,
        );
      if (!lastIn) continue;
      if (lastOut && lastIn <= lastOut) continue;
      // нет rejected-pending новее последнего IN
      const rejectedAfterIn = l.pendingReplies.some(
        (pr) => pr.createdAt > lastIn,
      );
      if (rejectedAfterIn) continue;
      hasNewIn = true;
      break;
    }
    if (hasNewIn) result.push(leadToLegacy(l));
  }
  return result;
}

// ─── Worker: decisions / approved-queue / follow-up (Шаг 3.3c-3) ─────────────

// Решённые сделки, ожидающие исполнения (admin_decision != pending, лид deal_pending).
async function listDecidedDealsPending(workspaceId) {
  const rows = await prisma.mktDeal.findMany({
    where: {
      lead: { workspaceId, dialogueStage: "DEAL_PENDING" },
      adminDecision: { in: ["APPROVED", "REJECTED"] },
    },
    include: {
      lead: {
        select: {
          id: true,
          email: true,
          telegram: true,
          channelName: true,
          dialogueStage: true,
        },
      },
    },
  });
  return rows.map((d) => ({
    ...dealToLegacy(d),
    l_id: d.lead.id,
    email: d.lead.email,
    telegram: d.lead.telegram,
    channel_name: d.lead.channelName,
    dialogue_stage: legacyEnum(DIALOGUE_STAGE_TO_LEGACY, d.lead.dialogueStage),
  }));
}

// Отвеченные консультации, ещё не продолженные в диалоге.
// Дедуп: нет out-сообщения с metadata.consultation_id === id (в JS, как json_extract).
async function listAnsweredConsultations(workspaceId) {
  const rows = await prisma.mktConsultation.findMany({
    where: {
      status: "answered",
      adminResponse: { not: null },
      lead: { workspaceId },
      leadId: { not: null },
    },
  });
  const out = [];
  for (const c of rows) {
    const continued = await prisma.mktMessage.findFirst({
      where: {
        dialogue: { lead: { workspaceId } },
        metadata: { contains: `"consultation_id":${JSON.stringify(c.id)}` },
      },
      select: { id: true },
    });
    if (!continued) {
      out.push({
        id: c.id,
        lead_id: c.leadId,
        question: c.question,
        admin_response: c.adminResponse,
        context: c.context,
      });
    }
  }
  return out;
}

// Approved pending replies (review-mode очередь отправки), по decided_at.
async function pickApprovedPendingReplies(workspaceId, limit) {
  const rows = await prisma.mktPendingReply.findMany({
    where: { status: "APPROVED", lead: { workspaceId } },
    include: {
      lead: { select: { email: true, telegram: true, channelName: true } },
    },
    orderBy: { decidedAt: "asc" },
    take: limit,
  });
  return rows.map((pr) => ({
    ...pendingReplyToLegacy(pr),
    lead_email: pr.lead ? pr.lead.email : null,
    lead_telegram: pr.lead ? pr.lead.telegram : null,
    channel_name: pr.lead ? pr.lead.channelName : null,
  }));
}

// Атомарный claim approved → sending (count===1). Защита от гонки тиков.
async function claimApprovedPendingReply(workspaceId, id) {
  const r = await prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId }, status: "APPROVED" },
    data: { status: "SENDING" },
  });
  return r.count === 1;
}
// Откат claim при ошибке отправки (sending → approved).
async function unclaimApprovedPendingReply(workspaceId, id) {
  return prisma.mktPendingReply.updateMany({
    where: { id, lead: { workspaceId }, status: "SENDING" },
    data: { status: "APPROVED" },
  });
}

// resend_id последнего out-сообщения диалога (для In-Reply-To заголовка).
async function getLastOutResendId(workspaceId, dialogueId) {
  const m = await prisma.mktMessage.findFirst({
    where: {
      dialogueId,
      direction: "OUT",
      dialogue: { lead: { workspaceId } },
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  if (!m || !m.metadata) return null;
  try {
    return JSON.parse(m.metadata).resend_id || null;
  } catch {
    return null;
  }
}

// Кандидаты на follow-up (зеркало pickFollowUpCandidates; условие в JS).
async function pickFollowUpCandidates(
  workspaceId,
  { maxAttempts, cutoffIso, limit },
) {
  const leads = await prisma.mktLead.findMany({
    where: {
      workspaceId,
      leadStatus: "IN_WORK",
      dialogueStage: {
        in: ["CONTACTED", "NEGOTIATING", "AWAITING_REPLY", "FOLLOWUP_1"],
      },
    },
    include: {
      dialogues: {
        include: { messages: { select: { direction: true, createdAt: true } } },
      },
      pendingReplies: {
        where: { status: { in: ["PENDING", "APPROVED"] } },
        select: { id: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const cutoff = new Date(cutoffIso);
  const out = [];
  for (const l of leads) {
    if ((l.followupAttempts || 0) >= maxAttempts) continue;
    if (l.pendingReplies.length > 0) continue; // есть pending/approved
    if (l.lastFollowupAt && l.lastFollowupAt >= cutoff) continue;
    // самый ранний диалог (ORDER BY d.created_at ASC), у которого последний OUT < cutoff
    // и последний IN <= последний OUT (блогер не ответил позже нашего)
    const sortedDlgs = [...l.dialogues].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    for (const d of sortedDlgs) {
      const outs = d.messages
        .filter((m) => m.direction === "OUT")
        .map((m) => m.createdAt);
      const ins = d.messages
        .filter((m) => m.direction === "IN")
        .map((m) => m.createdAt);
      if (outs.length === 0) continue;
      const lastOut = new Date(Math.max(...outs.map((x) => x.getTime())));
      const lastIn = ins.length
        ? new Date(Math.max(...ins.map((x) => x.getTime())))
        : null;
      if (lastOut >= cutoff) continue;
      if (lastIn && lastIn > lastOut) continue;
      out.push({
        ...leadToLegacy(l),
        dlg_id: d.id,
        dlg_channel: d.channel,
        last_out_at: iso(lastOut),
      });
      break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

// Consultations: создание + поиск pending (loop-limit/consultation_needed).
async function insertConsultation(workspaceId, p) {
  const lead = await prisma.mktLead.findFirst({
    where: { id: p.lead_id, workspaceId },
    select: { id: true },
  });
  if (!lead) return { id: null };
  const c = await prisma.mktConsultation.create({
    data: {
      leadId: p.lead_id,
      question: p.question,
      context: p.context ?? null,
      status: "pending",
      createdAt: toDate(p.created_at) ?? undefined,
    },
    select: { id: true },
  });
  return { id: c.id };
}
async function getPendingConsultation(workspaceId, leadId) {
  const c = await prisma.mktConsultation.findFirst({
    where: { leadId, lead: { workspaceId }, status: "pending" },
    select: { id: true },
  });
  return c || undefined;
}

// ─── Leads: вспомогательные чтения для routes/leads.js ───────────────────────

// зеркало inline: SELECT 1 FROM dialogues WHERE lead_id = ? LIMIT 1
async function hasDialogue(workspaceId, leadId) {
  const d = await prisma.mktDialogue.findFirst({
    where: { leadId, lead: { workspaceId } },
    select: { id: true },
  });
  return !!d;
}

// зеркало inline: DISTINCT каналы с исходящими сообщениями
async function listSentChannels(workspaceId, leadId) {
  const rows = await prisma.mktDialogue.findMany({
    where: {
      leadId,
      lead: { workspaceId },
      messages: { some: { direction: "OUT" } },
    },
    select: { channel: true },
    distinct: ["channel"],
  });
  return rows.map((r) => r.channel);
}

// зеркало inline: история по каналам (первый out-message, иначе created_at диалога)
async function listChannelsHistory(workspaceId, leadId) {
  const dialogues = await prisma.mktDialogue.findMany({
    where: { leadId, lead: { workspaceId } },
    include: {
      messages: {
        where: { direction: "OUT" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  const byChannel = new Map();
  for (const d of dialogues) {
    const sentAt = d.messages[0] ? d.messages[0].createdAt : d.createdAt;
    const prev = byChannel.get(d.channel);
    if (!prev || sentAt < prev) byChannel.set(d.channel, sentAt);
  }
  return [...byChannel.entries()].map(([channel, sentAt]) => ({
    channel,
    sent_at: iso(sentAt),
  }));
}

// зеркало inline: SELECT id FROM leads WHERE channel_id = ?
async function getLeadByChannelId(workspaceId, channelId) {
  const l = await prisma.mktLead.findUnique({
    where: { workspaceId_channelId: { workspaceId, channelId } },
    include: { analysis: true },
  });
  return leadToLegacy(l);
}

// зеркало stmts.listLeadsWithoutSummary.all(limit)
async function listLeadsWithoutSummary(workspaceId, limit) {
  const rows = await prisma.mktLead.findMany({
    where: {
      workspaceId,
      OR: [{ contentSummary: null }, { contentSummary: "" }],
    },
    include: { analysis: true },
    take: limit,
  });
  return rows.map(leadToLegacy);
}

// зеркало stmts.listLeadsForEnrichment.all(cutoff, limit)
async function listLeadsForEnrichment(workspaceId, cutoffIso, limit) {
  const rows = await prisma.mktLead.findMany({
    where: {
      workspaceId,
      OR: [{ enrichedAt: null }, { enrichedAt: { lt: toDate(cutoffIso) } }],
    },
    select: { id: true, channelId: true },
    take: limit,
  });
  return rows.map((r) => ({ id: r.id, channel_id: r.channelId }));
}

// зеркало stmts.listLeads без пагинации не нужно: ids всех лидов (scoring)
async function listAllLeadIds(workspaceId) {
  const rows = await prisma.mktLead.findMany({
    where: { workspaceId },
    select: { id: true },
  });
  return rows.map((r) => ({ id: r.id }));
}

// ─── Leads: вспомогательные записи для routes/leads.js ───────────────────────

// зеркало inline (bulk-run / run): подготовка лида к запуску воркера
async function resetLeadForRun(workspaceId, id, makeReady) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: {
      lockedUntil: null,
      dialogueStage: "NOT_CONTACTED",
      ...(makeReady ? { leadStatus: "READY" } : {}),
    },
  });
}

// зеркало inline: UPDATE leads SET raw_contacts = ? WHERE id = ?
async function patchLeadRawContacts(workspaceId, id, rawContactsJson) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: { rawContacts: rawContactsJson },
  });
}

// зеркало записи services/lead-scoring.js (lead_score + видео-метрики)
async function updateLeadScoring(workspaceId, id, p) {
  return prisma.mktLead.updateMany({
    where: { id, workspaceId },
    data: {
      leadScore: p.lead_score ?? null,
      scoreBreakdown: p.score_breakdown ?? null,
      shortsCount: p.shorts_count ?? null,
      shortsRatio: p.shorts_ratio ?? null,
      shortsAvgViews: p.shorts_avg_views ?? null,
      longAvgViews: p.long_avg_views ?? null,
      postingFrequency: p.posting_frequency ?? null,
      scoredAt: toDate(p.scored_at),
    },
  });
}

// зеркало DELETE /api/leads/:id (транзакция в SQLite) — каскад Prisma-relations
async function deleteLead(workspaceId, id) {
  return prisma.mktLead.deleteMany({ where: { id, workspaceId } });
}

// зеркало DELETE /api/leads/all — все лиды воркспейса (+consultations без лида)
async function deleteAllLeads(workspaceId) {
  await prisma.mktConsultation.deleteMany({
    where: { OR: [{ lead: { workspaceId } }, { leadId: null }] },
  });
  return prisma.mktLead.deleteMany({ where: { workspaceId } });
}

// ─── Tags (yt-parser tags + channel_tags → MktTag + MktLead.tagId) ───────────

function tagToLegacy(t) {
  if (!t) return t;
  return { id: t.id, name: t.name, color: t.color };
}

// зеркало: SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE
async function listTags(workspaceId) {
  const rows = await prisma.mktTag.findMany({
    where: { workspaceId },
    select: { id: true, name: true, color: true },
  });
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return rows.map(tagToLegacy);
}

async function countTags(workspaceId) {
  return prisma.mktTag.count({ where: { workspaceId } });
}

async function createTag(workspaceId, name, color) {
  const t = await prisma.mktTag.create({
    data: { workspaceId, name, color },
    select: { id: true, name: true, color: true },
  });
  return tagToLegacy(t);
}

async function getTag(workspaceId, id) {
  const t = await prisma.mktTag.findFirst({
    where: { id, workspaceId },
    select: { id: true, name: true, color: true },
  });
  return tagToLegacy(t);
}

async function updateTag(workspaceId, id, name, color) {
  await prisma.mktTag.updateMany({
    where: { id, workspaceId },
    data: { name, color },
  });
  return getTag(workspaceId, id);
}

// удаление: SetNull у лидов делает сама relation (onDelete: SetNull)
async function deleteTag(workspaceId, id) {
  return prisma.mktTag.deleteMany({ where: { id, workspaceId } });
}

// зеркало: SELECT channel_id, tag_id FROM channel_tags
async function listChannelTags(workspaceId) {
  const rows = await prisma.mktChannelTag.findMany({
    where: { workspaceId },
    select: { channelId: true, tagId: true },
  });
  return rows.map((r) => ({ channel_id: r.channelId, tag_id: r.tagId }));
}

// channel_tags — отдельная таблица MktChannelTag (тег живёт независимо от лида,
// поэтому теги не-лидов больше не теряются). Пишем туда И зеркалим на лид,
// если он уже существует, для консистентности lead.tagId.
async function setChannelTag(workspaceId, channelId, tagId) {
  await prisma.mktChannelTag.upsert({
    where: { workspaceId_channelId: { workspaceId, channelId } },
    create: { workspaceId, channelId, tagId },
    update: { tagId },
  });
  await prisma.mktLead.updateMany({
    where: { workspaceId, channelId },
    data: { tagId },
  });
}

async function removeChannelTag(workspaceId, channelId) {
  await prisma.mktChannelTag.deleteMany({ where: { workspaceId, channelId } });
  await prisma.mktLead.updateMany({
    where: { workspaceId, channelId },
    data: { tagId: null },
  });
}

// ─── Knowledge base (MktKnowledgeDoc + MktKnowledgeChunk) ────────────────────
// embedding в Prisma — String (JSON float-массив); BLOB-путь SQLite не трогаем.

const KNOWLEDGE_STATUS_TO_LEGACY = {
  PENDING: "pending",
  INDEXING: "indexing",
  INDEXED: "indexed",
  FAILED: "failed",
};
const KNOWLEDGE_STATUS_FROM_LEGACY = invert(KNOWLEDGE_STATUS_TO_LEGACY);

function knowledgeDocToLegacy(d, { withContent = false } = {}) {
  if (!d) return d;
  const out = {
    id: d.id,
    project_id: d.projectId,
    kind: d.kind,
    title: d.title,
    source: d.source,
    mime: d.mime,
    size_bytes: d.sizeBytes,
    chunks_count: d.chunksCount,
    status: legacyEnum(KNOWLEDGE_STATUS_TO_LEGACY, d.status),
    error: d.error,
    checksum: d.checksum,
    created_at: iso(d.createdAt),
    updated_at: iso(d.updatedAt),
  };
  if (withContent) out.content = d.content;
  return out;
}

// project_id IS NULL OR project_id = @pid OR project_id IS NULL → доки проекта + общие
function projectOrNullFilter(projectId) {
  return projectId ? { OR: [{ projectId }, { projectId: null }] } : {};
}

// зеркало stmts.insertKnowledgeDoc.run({...}) → { id }
async function insertKnowledgeDoc(workspaceId, p) {
  const d = await prisma.mktKnowledgeDoc.create({
    data: {
      workspaceId,
      projectId: p.project_id ?? null,
      kind: p.kind,
      title: p.title,
      source: p.source ?? null,
      mime: p.mime ?? null,
      sizeBytes: p.size_bytes ?? null,
      content: String(p.content ?? ""),
      checksum: p.checksum ?? null,
      status: "PENDING",
      createdAt: toDate(p.created_at) ?? undefined,
    },
    select: { id: true },
  });
  return { id: d.id };
}

// зеркало stmts.setKnowledgeDocStatus.run(status, error, updatedAt, id) +
// setKnowledgeDocChunks (status + chunksCount). chunksCount передаётся опционально.
async function updateKnowledgeDocStatus(
  workspaceId,
  docId,
  status,
  error = null,
  chunksCount = null,
) {
  const data = {
    status: KNOWLEDGE_STATUS_FROM_LEGACY[status] || "PENDING",
    error: error ?? null,
  };
  if (chunksCount != null) data.chunksCount = chunksCount;
  return prisma.mktKnowledgeDoc.updateMany({
    where: { id: docId, workspaceId },
    data,
  });
}

// зеркало stmts.updateKnowledgeDoc.run({...}) — COALESCE-семантика (URL refetch)
async function updateKnowledgeDocContent(workspaceId, docId, p) {
  const data = {};
  if (p.title != null) data.title = p.title;
  if (p.content != null) data.content = p.content;
  if (p.checksum != null) data.checksum = p.checksum;
  if (p.size_bytes != null) data.sizeBytes = p.size_bytes;
  if (p.status != null)
    data.status = KNOWLEDGE_STATUS_FROM_LEGACY[p.status] || "PENDING";
  if (p.error !== undefined) data.error = p.error;
  return prisma.mktKnowledgeDoc.updateMany({
    where: { id: docId, workspaceId },
    data,
  });
}

// зеркало stmts.listKnowledgeDocs.all({project_id}) — без content
async function listKnowledgeDocs(workspaceId, projectId) {
  const rows = await prisma.mktKnowledgeDoc.findMany({
    where: { workspaceId, ...projectOrNullFilter(projectId) },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((d) => knowledgeDocToLegacy(d));
}

// зеркало stmts.getKnowledgeDoc.get(id) — с content
async function getKnowledgeDoc(workspaceId, docId) {
  const d = await prisma.mktKnowledgeDoc.findFirst({
    where: { id: docId, workspaceId },
  });
  return knowledgeDocToLegacy(d, { withContent: true });
}

// зеркало stmts.deleteKnowledgeDoc.run(id) — каскад чанков (relation onDelete: Cascade)
async function deleteKnowledgeDoc(workspaceId, docId) {
  return prisma.mktKnowledgeDoc.deleteMany({
    where: { id: docId, workspaceId },
  });
}

// зеркало stmts.deleteChunksByDoc.run(docId) — удалить чанки дока (reindex)
async function deleteChunksByDoc(workspaceId, docId) {
  return prisma.mktKnowledgeChunk.deleteMany({
    where: { docId, doc: { workspaceId } },
  });
}

// зеркало stmts.insertKnowledgeChunk (пакетно). embedding — уже JSON-строка.
async function insertKnowledgeChunks(workspaceId, docId, chunks) {
  if (!chunks.length) return { count: 0 };
  return prisma.mktKnowledgeChunk.createMany({
    data: chunks.map((c) => ({
      docId,
      position: c.position,
      chunkText: c.chunk_text,
      embedding: c.embedding, // JSON-строка float-массива
      tokenCount: c.token_count ?? null,
    })),
  });
}

// зеркало stmts.getAllChunksForProject.all({project_id}) — embedding КАК ХРАНИТСЯ
// (JSON-строка; парсинг в Float32 — на стороне сервиса). Только status=indexed.
async function getChunksForProject(workspaceId, projectId) {
  const rows = await prisma.mktKnowledgeChunk.findMany({
    where: {
      doc: {
        workspaceId,
        status: "INDEXED",
        ...projectOrNullFilter(projectId),
      },
    },
    include: { doc: { select: { title: true, source: true, kind: true } } },
  });
  return rows.map((c) => ({
    id: c.id,
    doc_id: c.docId,
    position: c.position,
    chunk_text: c.chunkText,
    embedding: c.embedding, // JSON-строка
    doc_title: c.doc.title,
    doc_source: c.doc.source,
    doc_kind: c.doc.kind,
  }));
}

// Общая БЗ проекта (PUP KbChunk) — для аутрич-агента. STROГО workspace-scoped:
// только чанки этого воркспейса, никогда не кросс-workspace. embedding — JSON
// (парсинг в Float32 на стороне сервиса), форма строк зеркалит getChunksForProject.
async function getKbChunksForWorkspace(workspaceId) {
  if (!workspaceId) return [];
  const rows = await prisma.kbChunk.findMany({
    where: { workspaceId, embedding: { not: null } },
    select: {
      chunkText: true,
      sourceKind: true,
      embedding: true,
      article: { select: { title: true } },
      file: { select: { originalName: true } },
    },
  });
  return rows.map((c) => ({
    chunk_text: c.chunkText,
    source_kind: c.sourceKind,
    title: c.article?.title ?? c.file?.originalName ?? "",
    embedding: c.embedding, // JSON-строка
  }));
}

// зеркало stmts.knowledgeStats.get({project_id})
async function knowledgeStats(workspaceId, projectId) {
  const where = { workspaceId, ...projectOrNullFilter(projectId) };
  const groups = await prisma.mktKnowledgeDoc.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
    _sum: { chunksCount: true },
  });
  const out = {
    docs: 0,
    indexed: 0,
    pending: 0,
    indexing: 0,
    failed: 0,
    chunks: 0,
  };
  for (const g of groups) {
    const n = g._count._all;
    out.docs += n;
    out.chunks += g._sum.chunksCount || 0;
    const key = legacyEnum(KNOWLEDGE_STATUS_TO_LEGACY, g.status);
    if (key in out) out[key] = n;
  }
  return out;
}

// ─── Lead emails ──────────────────────────────────────────────────────────────

// зеркало syncLeadEmails(workspaceId, leadId, emailField) из database.js:
// полная пересинхронизация (delete + insert нормализованных адресов)
async function syncLeadEmails(workspaceId, leadId, emailField) {
  const lead = await prisma.mktLead.findFirst({
    where: { id: leadId, workspaceId },
    select: { id: true },
  });
  if (!lead) return { changes: 0 };
  await prisma.mktLeadEmail.deleteMany({ where: { leadId } });
  if (!emailField) return { changes: 1 };
  const emails = [
    ...new Set(
      String(emailField)
        .split(/[;,]/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (emails.length) {
    await prisma.mktLeadEmail.createMany({
      data: emails.map((email) => ({ leadId, email })),
      skipDuplicates: true,
    });
  }
  return { changes: 1 };
}

// Chat id'ы Telegram по списку логинов (для доп. получателей admin-bot уведомлений).
// Бот общий с основным ПУП, поэтому User.telegramChatId заполняется, когда человек
// привязывает Telegram в основном приложении.
async function getTelegramChatIdsByLogins(logins) {
  if (!Array.isArray(logins) || logins.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { login: { in: logins }, telegramChatId: { not: null } },
    select: { telegramChatId: true },
  });
  return users.map((u) => u.telegramChatId).filter(Boolean);
}

// Chat id'ы пользователей, включивших маркетинг-уведомления (тумблер tgNotifyMarketing
// в настройках профиля основного ПУП; бот общий).
async function getMarketingNotifyChatIds() {
  const users = await prisma.user.findMany({
    where: { tgNotifyMarketing: true, telegramChatId: { not: null } },
    select: { telegramChatId: true },
  });
  return users.map((u) => u.telegramChatId).filter(Boolean);
}

// Сохранить связь Telegram-сообщений консультации (для reply-ответа из TG основным ботом).
async function setConsultationTgMessages(consultationId, pairs) {
  return prisma.mktConsultation.updateMany({
    where: { id: consultationId },
    data: { tgMessageIds: JSON.stringify(pairs || []) },
  });
}

module.exports = {
  prisma,
  // tg accounts (encrypted)
  listTgAccounts,
  getTgAccount,
  createTgAccount,
  updateTgAccount,
  deleteTgAccount,
  setTgAccountStatus,
  getTgAccountById,
  listAllActiveTgAccounts,
  updateTgAccountById,
  setTgAccountStatusById,
  recordTgAccountSend,
  // worker plumbing
  listActiveWorkspaceIds,
  claimNextOutreachLead,
  getDailyCounts,
  hasPendingForChannel,
  updateLeadFields,
  getLatestDialogueByLead,
  findReplyMatch,
  findTgLeadMatch,
  tgIncomingExists,
  getDialogueAccountId,
  pickLeadsWithNewReplies,
  // admin-bot (ws-agnostic)
  listAllPendingDeals,
  decideDealById,
  getLeadById,
  answerConsultationById,
  countAllLeadsByStatus,
  countAllPendingConsultations,
  countAllPendingDeals,
  countAllPendingReplies,
  listAllDailyCounters,
  insertConsultation,
  getPendingConsultation,
  listDecidedDealsPending,
  listAnsweredConsultations,
  pickApprovedPendingReplies,
  claimApprovedPendingReply,
  unclaimApprovedPendingReply,
  getLastOutResendId,
  pickFollowUpCandidates,
  // leads
  listLeads,
  countLeads,
  getLead,
  // dialogues & messages
  getDialogue,
  listAllDialogues,
  listMessagesByLead,
  getLastOutgoingMessageOpen,
  // projects
  listProjects,
  getProject,
  getActiveProject,
  // pending replies
  listPendingReplies,
  countPendingReplies,
  getPendingReply,
  // deals
  listPendingDeals,
  // ── write: leads
  insertLead,
  updateLeadStatus,
  updateLeadStage,
  updateLeadProject,
  updateLeadNotes,
  setManualContact,
  updateLeadContacts,
  updateLeadEnrichment,
  updateLeadSummary,
  updateLeadSummaryDeep,
  lockLead,
  unlockLead,
  incrementLeadFollowUp,
  markLeadOptedOut,
  optOutLeadById,
  updateLeadAnalysis,
  hasDialogue,
  listSentChannels,
  listChannelsHistory,
  getLeadByChannelId,
  listLeadsWithoutSummary,
  listLeadsForEnrichment,
  listAllLeadIds,
  resetLeadForRun,
  patchLeadRawContacts,
  updateLeadScoring,
  deleteLead,
  deleteAllLeads,
  // ── write: dialogues
  insertDialogue,
  setDialogueAccount,
  updateDialogueThread,
  incrementDialogueMsgCount,
  // ── write: messages
  insertMessage,
  recordEmailEvent,
  recordMessageOpen,
  // ── write: pending replies
  insertPendingReply,
  approvePendingReply,
  rejectPendingReply,
  markPendingReplySent,
  markPendingReplyFailed,
  setPendingReplySendAfter,
  findMessageOpenByPendingReplyId,
  deletePendingReply,
  purgeOldPendingReplies,
  updatePendingReplyContent,
  retryPendingReply,
  listMessagesByDialogue,
  getAnyDialogueByLead,
  setMessageContentRu,
  getAgentLeadStats,
  // ── write: deals
  insertDeal,
  decideDeal,
  // ── write: counters / projects / settings / emails
  upsertDailyCounters,
  insertProject,
  updateProject,
  deactivateAllProjects,
  activateProject,
  deleteProject,
  upsertSetting,
  getSetting,
  getTelegramChatIdsByLogins,
  getMarketingNotifyChatIds,
  setConsultationTgMessages,
  syncLeadEmails,
  // consultations / deals listing
  listConsultations,
  answerConsultation,
  listDealsByDecision,
  // knowledge base
  insertKnowledgeDoc,
  updateKnowledgeDocStatus,
  updateKnowledgeDocContent,
  listKnowledgeDocs,
  getKnowledgeDoc,
  deleteKnowledgeDoc,
  deleteChunksByDoc,
  insertKnowledgeChunks,
  getChunksForProject,
  getKbChunksForWorkspace,
  knowledgeStats,
  // tags
  listTags,
  countTags,
  createTag,
  getTag,
  updateTag,
  deleteTag,
  listChannelTags,
  setChannelTag,
  removeChannelTag,
  // мапперы (для тестов/переходного кода)
  leadToLegacy,
  dialogueToLegacy,
  messageToLegacy,
  projectToLegacy,
  pendingReplyToLegacy,
  dealToLegacy,
};
