/**
 * migrate-ytparser-to-prisma.ts — перенос маркетинговых данных yt-parser → Prisma.
 *
 * Часть плана унификации БД маркетинга (см. ../_docs/TZ-marketing-db-unification.md).
 * Источник: tools/yt-parser/data/ws-*.db (better-sqlite3, по базе на воркспейс).
 * Приёмник: Prisma (Mkt*-модели). Натуральный ключ склейки: (workspaceId, channelId).
 *
 * Запуск:
 *   tsx scripts/migrate-ytparser-to-prisma.ts --dry-run   # отчёт, БЕЗ записи
 *   tsx scripts/migrate-ytparser-to-prisma.ts             # реальный перенос
 *
 * Скрипт идемпотентен: повторный запуск не дублирует данные (upsert по
 * натуральным ключам, сообщения — skip по (dialogueId, createdAt, content)).
 */
/* eslint-disable @typescript-eslint/no-explicit-any --
   одноразовый миграционный инструмент: строки SQLite нетипизированы,
   enum-значения кастуются после явного маппинга; удаляется после Батча 3 */

import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
// Шифрование секретов TG-аккаунта (AES-256-GCM, ключ из ENCRYPTION_KEY||AUTH_SECRET).
// crypto.service.ts помечен "server-only" → запускать через: tsx --conditions=react-server
import { encrypt } from "../lib/services/crypto.service";

// ─── Карта воркспейсов (заполняет владелец) ─────────────────────────────────
// Ключ: имя файла ws-XXX.db без префикса "ws-" и суффикса ".db".
// Значение: Prisma Workspace.id (cuid). Файлы без записи в карте НЕ мигрируются.
// Переопределяется через env WORKSPACE_MAP_JSON (для прод-прогона на копии),
// иначе — дефолтная dev-карта (не клобберим локальную разработку).
const DEFAULT_WORKSPACE_MAP: Record<string, string> = {
  "qa-tg": "cmqbkwccn0001onqtv7q6ihrd", // ws-qa-tg.db → "QA / Telegram Outreach" (scripts/create-workspace.ts)
  // "default": без маппинга — файл пуст, пропускается с WARN
};
const WORKSPACE_MAP: Record<string, string> = process.env.WORKSPACE_MAP_JSON
  ? (JSON.parse(process.env.WORKSPACE_MAP_JSON) as Record<string, string>)
  : DEFAULT_WORKSPACE_MAP;

// Каталог с ws-*.db. Переопределяется через env YT_DATA_DIR_OVERRIDE
// (прод-снимки), иначе — дефолтный dev-каталог парсера.
const YT_DATA_DIR = process.env.YT_DATA_DIR_OVERRIDE
  ? path.resolve(process.env.YT_DATA_DIR_OVERRIDE)
  : path.join(__dirname, "..", "tools", "yt-parser", "data");

const DRY_RUN = process.argv.includes("--dry-run");
const prisma = new PrismaClient();

// ─── Маппинг статусов (snake → enum), неизвестное → дефолт + WARN ───────────

const unmappedValues: string[] = []; // глобальный сбор для отчёта

function mapEnum(
  raw: string | null | undefined,
  table: Record<string, string>,
  fallback: string,
  ctx: string,
): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "" && fallback === "PENDING" && ctx.startsWith("deals"))
    return "PENDING"; // ''/null → PENDING без WARN (ожидаемо для deals)
  const mapped = table[key];
  if (mapped !== undefined) return mapped;
  if (key !== "") unmappedValues.push(`${ctx}: "${raw}" → дефолт ${fallback}`);
  return fallback;
}

const LEAD_STATUS: Record<string, string> = {
  pending: "PENDING",
  ready: "READY",
  in_work: "IN_WORK",
  done: "DONE",
  rejected: "REJECTED",
};

const DIALOGUE_STAGE: Record<string, string> = {
  not_contacted: "NOT_CONTACTED",
  queued: "QUEUED",
  awaiting_review: "AWAITING_REVIEW",
  contacted: "CONTACTED",
  awaiting_reply: "AWAITING_REPLY",
  followup_1: "FOLLOWUP_1",
  followup_2: "FOLLOWUP_2",
  replied: "REPLIED",
  negotiating: "NEGOTIATING",
  deal_pending: "DEAL_PENDING",
  won: "WON",
  lost: "LOST",
  moved_to_tg: "MOVED_TO_TG",
};

const MSG_DIRECTION: Record<string, string> = { in: "IN", out: "OUT" };

const MSG_SENDER: Record<string, string> = {
  agent: "AGENT",
  admin: "ADMIN",
  blogger: "EXTERNAL",
};

const DEAL_DECISION: Record<string, string> = {
  approved: "APPROVED",
  rejected: "REJECTED",
};

const PENDING_STATUS: Record<string, string> = {
  pending: "PENDING",
  approved: "APPROVED",
  rejected: "REJECTED",
  sent: "SENT",
  failed: "FAILED",
};

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  const d = new Date(typeof v === "number" ? v : String(v));
  return isNaN(d.getTime()) ? null : d;
}

function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === "1" || v === "true";
}

function toStr(v: unknown): string | null {
  return v == null ? null : String(v);
}

// Зашифровать секрет (null/'' → null без вызова encrypt).
function enc(v: unknown): string | null {
  const s = toStr(v);
  return s && s.length > 0 ? encrypt(s) : null;
}

interface Counts {
  insert: number;
  update: number;
  skip: number;
}
function newCounts(): Counts {
  return { insert: 0, update: 0, skip: 0 };
}

interface EntityCounts {
  projects: Counts;
  leads: Counts;
  leadAnalysis: Counts;
  dialogues: Counts;
  messages: Counts;
  deals: Counts;
  pendingReplies: Counts;
  consultations: Counts;
  leadEmails: Counts;
  tgAccounts: Counts;
}

interface WsReport {
  wsKey: string;
  workspaceId: string;
  counts: EntityCounts;
  warnings: string[];
  leadsWithoutChannelId: number;
  dialoguesWithoutLead: number;
}

// ─── Миграция одного воркспейса ──────────────────────────────────────────────

async function migrateWorkspace(
  dbFile: string,
  wsKey: string,
  workspaceId: string,
): Promise<WsReport> {
  const report: WsReport = {
    wsKey,
    workspaceId,
    counts: {
      projects: newCounts(),
      leads: newCounts(),
      leadAnalysis: newCounts(),
      dialogues: newCounts(),
      messages: newCounts(),
      deals: newCounts(),
      pendingReplies: newCounts(),
      consultations: newCounts(),
      leadEmails: newCounts(),
      tgAccounts: newCounts(),
    },
    warnings: [],
    leadsWithoutChannelId: 0,
    dialoguesWithoutLead: 0,
  };

  const sq = new Database(dbFile, { readonly: true, fileMustExist: true });

  try {
    // ── 1. projects → upsert по (workspaceId, name) ──────────────────────────
    const projectIdMap = new Map<number, string>(); // old project_id → new cuid
    const projects = sq.prepare(`SELECT * FROM projects`).all() as any[];

    for (const p of projects) {
      const name = toStr(p.name) ?? `(без имени #${p.id})`;
      const data = {
        description: toStr(p.description) ?? "",
        uniqueSellingPoints: toStr(p.unique_selling_points),
        targetAudience: toStr(p.target_audience),
        budgetMin: p.budget_min ?? null,
        budgetMax: p.budget_max ?? null,
        adFormats: toStr(p.ad_formats),
        language: toStr(p.language) ?? "ru",
        isActive: toBool(p.is_active),
        agentPersona: toStr(p.agent_persona),
        idealChannelProfile: toStr(p.ideal_channel_profile),
        badFitExamples: toStr(p.bad_fit_examples),
        proofPoints: toStr(p.proof_points),
        signature: toStr(p.signature),
        ctaText: toStr(p.cta_text),
        ctaLink: toStr(p.cta_link),
        creatorEconomics: toStr(p.creator_economics),
        toneOfVoice: toStr(p.tone_of_voice),
        stopWords: toStr(p.stop_words),
        systemPrompt: toStr(p.system_prompt),
        adminDirective: toStr(p.admin_directive),
        pitchTemperature: p.pitch_temperature ?? null,
        replyDelayMin: p.reply_delay_min ?? null,
        replyDelayMax: p.reply_delay_max ?? null,
        subjectPool: toStr(p.subject_pool),
        samplePitches: toStr(p.sample_pitches),
        contentRedFlags: toStr(p.content_red_flags),
        valuePropShort: toStr(p.value_prop_short),
      };

      const existing = await prisma.mktProject.findFirst({
        where: { workspaceId, name },
        select: { id: true },
      });

      if (existing) {
        report.counts.projects.update++;
        if (!DRY_RUN) {
          await prisma.mktProject.update({ where: { id: existing.id }, data });
        }
        projectIdMap.set(p.id, existing.id);
      } else {
        report.counts.projects.insert++;
        if (!DRY_RUN) {
          const created = await prisma.mktProject.create({
            data: { workspaceId, name, ...data },
          });
          projectIdMap.set(p.id, created.id);
        } else {
          projectIdMap.set(p.id, `(dry-run:new-project-${p.id})`);
        }
      }
    }

    // ── 2. leads → upsert по (workspaceId, channelId) ────────────────────────
    const leadIdMap = new Map<number, string>(); // old lead id → new cuid
    const leads = sq.prepare(`SELECT * FROM leads`).all() as any[];

    for (const l of leads) {
      const channelId = toStr(l.channel_id);
      if (!channelId) {
        report.leadsWithoutChannelId++;
        report.warnings.push(`lead #${l.id} без channel_id — пропущен`);
        continue;
      }

      const newProjectId =
        l.project_id != null ? (projectIdMap.get(l.project_id) ?? null) : null;
      if (l.project_id != null && newProjectId == null) {
        report.warnings.push(
          `lead #${l.id}: project_id=${l.project_id} не найден среди проектов — связь обнулена`,
        );
      }
      // В dry-run новые проекты имеют фиктивный id — связь проставится только в real-режиме
      const projectIdForWrite = newProjectId?.startsWith("(dry-run")
        ? null
        : newProjectId;

      const data = {
        channelName: toStr(l.channel_name),
        channelUrl: toStr(l.channel_url),
        thumbnail: toStr(l.thumbnail),
        source: "YOUTUBE" as const,
        country: toStr(l.country),
        subscribers: l.subscribers ?? null,
        avgViews: l.avg_views ?? null,
        engagementRate: l.engagement_rate ?? null,
        erNormalized: l.er_normalized ?? null,
        erFlags: toStr(l.er_flags),
        email: toStr(l.email),
        telegram: toStr(l.telegram),
        whatsapp: toStr(l.whatsapp),
        rawContacts: toStr(l.raw_contacts),
        keyword: toStr(l.keyword),
        tgDraft: toStr(l.tg_draft),
        tgDraftRu: toStr(l.tg_draft_ru),
        leadStatus: mapEnum(
          l.lead_status,
          LEAD_STATUS,
          "PENDING",
          `leads.lead_status(#${l.id})`,
        ) as any,
        dialogueStage: mapEnum(
          l.dialogue_stage,
          DIALOGUE_STAGE,
          "NOT_CONTACTED",
          `leads.dialogue_stage(#${l.id})`,
        ) as any,
        leadScore: l.lead_score ?? null,
        scoreBreakdown: toStr(l.score_breakdown),
        contentSummary: toStr(l.content_summary),
        isDeepSummary: toBool(l.is_deep_summary),
        channelAboutText: toStr(l.channel_about_text),
        channelTags: toStr(l.channel_tags),
        channelLanguage: toStr(l.channel_language),
        mainCategory: toStr(l.main_category),
        channelAgeDays: l.channel_age_days ?? null,
        lastVideosJson: toStr(l.last_videos_json),
        topPlaylistsJson: toStr(l.top_playlists_json),
        postingFrequency: l.posting_frequency ?? null,
        shortsCount: l.shorts_count ?? null,
        shortsRatio: l.shorts_ratio ?? null,
        shortsAvgViews: l.shorts_avg_views ?? null,
        longAvgViews: l.long_avg_views ?? null,
        projectId: projectIdForWrite,
        agreedPrice: l.agreed_price ?? null,
        notes: toStr(l.notes),
        optedOut: toBool(l.opted_out),
        lockedUntil: toDate(l.locked_until),
        followupAttempts: l.followup_attempts ?? 0,
        lastFollowupAt: toDate(l.last_followup_at),
        enrichedAt: toDate(l.enriched_at),
        scoredAt: toDate(l.scored_at),
      };

      const existing = await prisma.mktLead.findUnique({
        where: { workspaceId_channelId: { workspaceId, channelId } },
        select: { id: true },
      });

      let newLeadId: string;
      if (existing) {
        report.counts.leads.update++;
        newLeadId = existing.id;
        if (!DRY_RUN) {
          await prisma.mktLead.update({ where: { id: existing.id }, data });
        }
      } else {
        report.counts.leads.insert++;
        if (!DRY_RUN) {
          const created = await prisma.mktLead.create({
            data: {
              workspaceId,
              channelId,
              createdAt: toDate(l.created_at) ?? undefined,
              ...data,
            },
          });
          newLeadId = created.id;
        } else {
          newLeadId = `(dry-run:new-lead-${l.id})`;
        }
      }
      leadIdMap.set(l.id, newLeadId);

      // ── 2.1 analysis_* → MktLeadAnalysis (upsert по leadId) ────────────────
      const hasAnalysis =
        l.analysis_metrics != null ||
        l.analysis_reasoning != null ||
        l.analysis_recommendation != null ||
        l.analysis_score != null ||
        l.analysis_verdict != null ||
        l.analyzed_at != null;

      if (hasAnalysis) {
        const aData = {
          metrics: toStr(l.analysis_metrics),
          reasoning: toStr(l.analysis_reasoning),
          recommendation: toStr(l.analysis_recommendation),
          score: l.analysis_score ?? null,
          verdict: toStr(l.analysis_verdict),
          analyzedAt: toDate(l.analyzed_at),
        };
        if (newLeadId.startsWith("(dry-run")) {
          report.counts.leadAnalysis.insert++; // новый лид → анализ тоже новый
        } else {
          const aExisting = await prisma.mktLeadAnalysis.findUnique({
            where: { leadId: newLeadId },
            select: { id: true },
          });
          if (aExisting) report.counts.leadAnalysis.update++;
          else report.counts.leadAnalysis.insert++;
          if (!DRY_RUN) {
            await prisma.mktLeadAnalysis.upsert({
              where: { leadId: newLeadId },
              update: aData,
              create: { leadId: newLeadId, ...aData },
            });
          }
        }
      }
    }

    // ── 3. dialogues → match по (leadId, channel, externalThreadId) ──────────
    const dialogueIdMap = new Map<number, string>();
    const dialogues = sq.prepare(`SELECT * FROM dialogues`).all() as any[];

    for (const d of dialogues) {
      const newLeadId = leadIdMap.get(d.lead_id);
      if (!newLeadId) {
        report.dialoguesWithoutLead++;
        report.warnings.push(
          `dialogue #${d.id}: lead_id=${d.lead_id} не найден — пропущен`,
        );
        continue;
      }

      const channel = toStr(d.channel) ?? "email";
      const externalThreadId = toStr(d.external_thread_id);
      const accountId = d.account_id != null ? String(d.account_id) : null;

      if (newLeadId.startsWith("(dry-run")) {
        report.counts.dialogues.insert++; // новый лид → диалог новый
        dialogueIdMap.set(d.id, `(dry-run:new-dialogue-${d.id})`);
        continue;
      }

      const existing = await prisma.mktDialogue.findFirst({
        where: { leadId: newLeadId, channel, externalThreadId },
        select: { id: true },
      });

      if (existing) {
        report.counts.dialogues.update++;
        dialogueIdMap.set(d.id, existing.id);
        if (!DRY_RUN) {
          await prisma.mktDialogue.update({
            where: { id: existing.id },
            data: { accountId },
          });
        }
      } else {
        report.counts.dialogues.insert++;
        if (!DRY_RUN) {
          const created = await prisma.mktDialogue.create({
            data: {
              leadId: newLeadId,
              channel,
              externalThreadId,
              accountId,
              createdAt: toDate(d.created_at) ?? undefined,
            },
          });
          dialogueIdMap.set(d.id, created.id);
        } else {
          dialogueIdMap.set(d.id, `(dry-run:new-dialogue-${d.id})`);
        }
      }
    }

    // ── 4. messages → insert по порядку created_at; skip-дубликаты ───────────
    const messages = sq
      .prepare(`SELECT * FROM messages ORDER BY dialogue_id, created_at, id`)
      .all() as any[];

    for (const m of messages) {
      const newDialogueId = dialogueIdMap.get(m.dialogue_id);
      if (!newDialogueId) {
        report.warnings.push(
          `message #${m.id}: dialogue_id=${m.dialogue_id} не найден — пропущено`,
        );
        continue;
      }

      const content = toStr(m.content) ?? "";
      const createdAt = toDate(m.created_at) ?? new Date(0);

      if (!newDialogueId.startsWith("(dry-run")) {
        const dup = await prisma.mktMessage.findFirst({
          where: { dialogueId: newDialogueId, createdAt, content },
          select: { id: true },
        });
        if (dup) {
          report.counts.messages.skip++;
          continue;
        }
      }

      report.counts.messages.insert++;
      if (!DRY_RUN && !newDialogueId.startsWith("(dry-run")) {
        await prisma.mktMessage.create({
          data: {
            dialogueId: newDialogueId,
            direction: mapEnum(
              m.direction,
              MSG_DIRECTION,
              "IN",
              `messages.direction(#${m.id})`,
            ) as any,
            sender: mapEnum(
              m.sender,
              MSG_SENDER,
              "EXTERNAL",
              `messages.sender(#${m.id})`,
            ) as any,
            content,
            contentRu: toStr(m.content_ru),
            subject: toStr(m.subject), // в текущей схеме парсера колонки нет → null
            metadata: toStr(m.metadata),
            resendId: toStr(m.resend_id),
            trackingId: toStr(m.tracking_id),
            openedAt: toDate(m.opened_at),
            openCount: m.open_count ?? 0,
            createdAt,
          },
        });
      } else if (DRY_RUN && !newDialogueId.startsWith("(dry-run")) {
        // прогреем маппинги для отчёта о несмаппленных значениях
        mapEnum(
          m.direction,
          MSG_DIRECTION,
          "IN",
          `messages.direction(#${m.id})`,
        );
        mapEnum(m.sender, MSG_SENDER, "EXTERNAL", `messages.sender(#${m.id})`);
      } else {
        mapEnum(
          m.direction,
          MSG_DIRECTION,
          "IN",
          `messages.direction(#${m.id})`,
        );
        mapEnum(m.sender, MSG_SENDER, "EXTERNAL", `messages.sender(#${m.id})`);
      }
    }

    // ── 5. deals → по (leadId, projectId) ────────────────────────────────────
    const deals = sq.prepare(`SELECT * FROM deals`).all() as any[];

    for (const dl of deals) {
      const newLeadId = leadIdMap.get(dl.lead_id);
      const newProjectId =
        dl.project_id != null ? projectIdMap.get(dl.project_id) : null;
      if (!newLeadId || !newProjectId) {
        report.warnings.push(
          `deal #${dl.id}: lead/project не найдены (lead_id=${dl.lead_id}, project_id=${dl.project_id}) — пропущена`,
        );
        continue;
      }

      const decision = mapEnum(
        dl.admin_decision,
        DEAL_DECISION,
        "PENDING",
        `deals.admin_decision(#${dl.id})`,
      ) as any;

      const isDryNew =
        newLeadId.startsWith("(dry-run") || newProjectId.startsWith("(dry-run");

      const existing = isDryNew
        ? null
        : await prisma.mktDeal.findFirst({
            where: { leadId: newLeadId, projectId: newProjectId },
            select: { id: true },
          });

      const data = {
        proposedPrice: dl.proposed_price ?? null,
        agentSummary: toStr(dl.agent_summary),
        adminDecision: decision,
        adminNotes: toStr(dl.admin_notes),
        decidedAt: toDate(dl.decided_at),
      };

      if (existing) {
        report.counts.deals.update++;
        if (!DRY_RUN) {
          await prisma.mktDeal.update({ where: { id: existing.id }, data });
        }
      } else {
        report.counts.deals.insert++;
        if (!DRY_RUN && !isDryNew) {
          await prisma.mktDeal.create({
            data: {
              leadId: newLeadId,
              projectId: newProjectId,
              createdAt: toDate(dl.created_at) ?? undefined,
              ...data,
            },
          });
        }
      }
    }

    // ── 6. pending_replies → по (leadId, createdAt) ──────────────────────────
    const pendings = sq.prepare(`SELECT * FROM pending_replies`).all() as any[];

    for (const pr of pendings) {
      const newLeadId = leadIdMap.get(pr.lead_id);
      if (!newLeadId) {
        report.warnings.push(
          `pending_reply #${pr.id}: lead_id=${pr.lead_id} не найден — пропущен`,
        );
        continue;
      }

      const createdAt = toDate(pr.created_at) ?? new Date(0);
      const newDialogueId =
        pr.dialogue_id != null
          ? (dialogueIdMap.get(pr.dialogue_id) ?? null)
          : null;
      const dialogueIdForWrite = newDialogueId?.startsWith("(dry-run")
        ? null
        : newDialogueId;

      const status = mapEnum(
        pr.status,
        PENDING_STATUS,
        "PENDING",
        `pending_replies.status(#${pr.id})`,
      ) as any;

      const isDryNew = newLeadId.startsWith("(dry-run");
      const existing = isDryNew
        ? null
        : await prisma.mktPendingReply.findFirst({
            where: { leadId: newLeadId, createdAt },
            select: { id: true },
          });

      const data = {
        dialogueId: dialogueIdForWrite,
        channel: toStr(pr.channel) ?? "email",
        recipient: toStr(pr.recipient) ?? "",
        subject: toStr(pr.subject),
        body: toStr(pr.body) ?? "",
        context: toStr(pr.context),
        status,
        editedBody: toStr(pr.edited_body),
        editedSubject: toStr(pr.edited_subject),
        adminNotes: toStr(pr.admin_notes),
        decidedAt: toDate(pr.decided_at),
        sentAt: toDate(pr.sent_at),
        sendAfter: toDate(pr.send_after),
      };

      if (existing) {
        report.counts.pendingReplies.update++;
        if (!DRY_RUN) {
          await prisma.mktPendingReply.update({
            where: { id: existing.id },
            data,
          });
        }
      } else {
        report.counts.pendingReplies.insert++;
        if (!DRY_RUN && !isDryNew) {
          await prisma.mktPendingReply.create({
            data: { leadId: newLeadId, createdAt, ...data },
          });
        }
      }
    }

    // ── 7a. consultations → по (leadId, createdAt) ───────────────────────────
    const consultations = sq
      .prepare(`SELECT * FROM consultations`)
      .all() as any[];

    for (const c of consultations) {
      const newLeadId = c.lead_id != null ? leadIdMap.get(c.lead_id) : null;
      if (c.lead_id != null && !newLeadId) {
        report.warnings.push(
          `consultation #${c.id}: lead_id=${c.lead_id} не найден — пропущена`,
        );
        continue;
      }

      const createdAt = toDate(c.created_at) ?? new Date(0);
      const leadIdForWrite = newLeadId?.startsWith("(dry-run")
        ? null
        : newLeadId;
      const isDryNew = newLeadId != null && newLeadId.startsWith("(dry-run");

      const existing = isDryNew
        ? null
        : await prisma.mktConsultation.findFirst({
            where: { leadId: leadIdForWrite ?? null, createdAt },
            select: { id: true },
          });

      const data = {
        question: toStr(c.question) ?? "",
        context: toStr(c.context),
        adminResponse: toStr(c.admin_response),
        status: toStr(c.status) ?? "pending",
        answeredAt: toDate(c.answered_at),
      };

      if (existing) {
        report.counts.consultations.update++;
        if (!DRY_RUN) {
          await prisma.mktConsultation.update({
            where: { id: existing.id },
            data,
          });
        }
      } else {
        report.counts.consultations.insert++;
        if (!DRY_RUN && !isDryNew) {
          await prisma.mktConsultation.create({
            data: { leadId: leadIdForWrite, createdAt, ...data },
          });
        }
      }
    }

    // ── 7b. lead_emails → upsert по (leadId, email) ──────────────────────────
    const leadEmails = sq.prepare(`SELECT * FROM lead_emails`).all() as any[];

    for (const le of leadEmails) {
      const newLeadId = leadIdMap.get(le.lead_id);
      const email = toStr(le.email);
      if (!newLeadId || !email) {
        report.warnings.push(
          `lead_email (lead_id=${le.lead_id}): лид не найден или пустой email — пропущен`,
        );
        continue;
      }

      if (newLeadId.startsWith("(dry-run")) {
        report.counts.leadEmails.insert++;
        continue;
      }

      const existing = await prisma.mktLeadEmail.findUnique({
        where: { leadId_email: { leadId: newLeadId, email } },
        select: { id: true },
      });

      if (existing) {
        report.counts.leadEmails.skip++;
      } else {
        report.counts.leadEmails.insert++;
        if (!DRY_RUN) {
          await prisma.mktLeadEmail.create({
            data: { leadId: newLeadId, email },
          });
        }
      }
    }

    // ── 7c. tg_account → MktTgAccount ────────────────────────────────────────
    // Секреты (session, two_fa, api_hash, proxy_pass) шифруются.
    // Идемпотентность: dedup по (workspaceId, phone); если phone пуст — по
    // user_id, иначе по label. floodUntil — BigInt(ms).
    let tgRows: any[] = [];
    try {
      tgRows = sq.prepare(`SELECT * FROM tg_account`).all() as any[];
    } catch {
      tgRows = []; // в этой ws-БД нет таблицы tg_account — нечего переносить
    }

    for (const a of tgRows) {
      const phone = toStr(a.phone);
      const userId = toStr(a.user_id);
      const label = toStr(a.label);

      // Натуральный ключ для dedup в рамках воркспейса.
      const where: any = { workspaceId };
      if (phone) where.phone = phone;
      else if (userId) where.userId = userId;
      else if (label) where.label = label;
      else {
        report.warnings.push(
          `tg_account #${a.id}: нет phone/user_id/label — пропущен (нельзя дедуплицировать)`,
        );
        continue;
      }

      const data = {
        label,
        phone,
        apiId: a.api_id ?? null,
        apiHash: enc(a.api_hash), // ENCRYPTED
        session: enc(a.session), // ENCRYPTED
        proxyType: toStr(a.proxy_type),
        proxyHost: toStr(a.proxy_host),
        proxyPort: a.proxy_port ?? null,
        proxyUser: toStr(a.proxy_user),
        proxyPass: enc(a.proxy_pass), // ENCRYPTED
        status: toStr(a.status) ?? "active",
        firstUsedAt: toStr(a.first_used_at),
        sentToday: a.sent_today ?? 0,
        sentTodayDate: toStr(a.sent_today_date),
        dailyCap: a.daily_cap ?? 50,
        floodUntil: a.flood_until != null ? BigInt(a.flood_until) : null,
        lastSentAt: toStr(a.last_sent_at),
        twoFa: enc(a.two_fa), // ENCRYPTED
        userId,
        deviceModel: toStr(a.device_model),
        systemVersion: toStr(a.system_version),
        appVersion: toStr(a.app_version),
        langCode: toStr(a.lang_code),
        systemLangCode: toStr(a.system_lang_code),
        source: toStr(a.source),
        firstName: toStr(a.first_name),
        lastName: toStr(a.last_name),
        username: toStr(a.username),
        metadata: toStr(a.metadata),
      };

      const existing = await prisma.mktTgAccount.findFirst({
        where,
        select: { id: true },
      });

      if (existing) {
        report.counts.tgAccounts.update++;
        if (!DRY_RUN) {
          await prisma.mktTgAccount.update({
            where: { id: existing.id },
            data,
          });
        }
      } else {
        report.counts.tgAccounts.insert++;
        if (!DRY_RUN) {
          await prisma.mktTgAccount.create({
            data: {
              workspaceId,
              createdAt: toDate(a.created_at) ?? undefined,
              ...data,
            },
          });
        }
      }
    }
  } finally {
    sq.close();
  }

  return report;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `\n━━━ Миграция yt-parser → Prisma ${DRY_RUN ? "[DRY-RUN — записи НЕ будет]" : "[РЕАЛЬНЫЙ ПРОГОН]"} ━━━\n`,
  );

  // Найти все ws-*.db
  const files = fs
    .readdirSync(YT_DATA_DIR)
    .filter((f) => /^ws-.+\.db$/.test(f))
    .sort();

  if (files.length === 0) {
    console.log(
      `Файлы ws-*.db не найдены в ${YT_DATA_DIR}. Нечего мигрировать.`,
    );
    return;
  }

  console.log(`Найдено файлов: ${files.length}`);
  const skipped: string[] = [];
  const reports: WsReport[] = [];

  for (const f of files) {
    const wsKey = f.replace(/^ws-/, "").replace(/\.db$/, "");
    const workspaceId = WORKSPACE_MAP[wsKey];
    if (!workspaceId) {
      skipped.push(wsKey);
      console.log(
        `⚠ WARN: "${f}" (ключ "${wsKey}") отсутствует в WORKSPACE_MAP — НЕ мигрируется.`,
      );
      continue;
    }

    // Проверим, что воркспейс существует в Prisma
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
    if (!ws) {
      skipped.push(wsKey);
      console.log(
        `⚠ WARN: "${f}" → Workspace.id="${workspaceId}" не найден в Prisma — НЕ мигрируется.`,
      );
      continue;
    }

    console.log(`→ Мигрируем "${f}" → workspace "${ws.name}" (${ws.id})`);
    reports.push(
      await migrateWorkspace(path.join(YT_DATA_DIR, f), wsKey, ws.id),
    );
  }

  // ─── Отчёт ──────────────────────────────────────────────────────────────
  console.log(`\n━━━ ОТЧЁТ ━━━`);
  console.log(`Файлы найдены: ${files.join(", ")}`);
  console.log(
    `Без маппинга (пропущены): ${skipped.length ? skipped.join(", ") : "—"}`,
  );

  for (const r of reports) {
    console.log(`\n── Воркспейс "${r.wsKey}" → ${r.workspaceId}`);
    console.log(
      `   ${"сущность".padEnd(16)} ${"insert".padStart(7)} ${"update".padStart(7)} ${"skip".padStart(5)}`,
    );
    for (const [entity, c] of Object.entries(r.counts)) {
      console.log(
        `   ${entity.padEnd(16)} ${String(c.insert).padStart(7)} ${String(c.update).padStart(7)} ${String(c.skip).padStart(5)}`,
      );
    }
    console.log(`   Лиды без channelId: ${r.leadsWithoutChannelId}`);
    console.log(`   Диалоги без лида:   ${r.dialoguesWithoutLead}`);
    if (r.warnings.length) {
      console.log(`   Предупреждения:`);
      for (const w of r.warnings) console.log(`     ⚠ ${w}`);
    }
  }

  if (unmappedValues.length) {
    console.log(`\n⚠ Несмаппленные значения статусов (ушли в дефолт):`);
    for (const u of unmappedValues) console.log(`   ${u}`);
  } else {
    console.log(`\n✓ Все значения статусов смаппились без дефолтов.`);
  }

  if (skipped.length) {
    const wss = await prisma.workspace.findMany({
      select: { id: true, name: true },
    });
    console.log(
      `\nПодсказка — доступные Prisma Workspace (для WORKSPACE_MAP):`,
    );
    for (const w of wss) console.log(`   "${w.id}"  // ${w.name}`);
  }

  console.log(
    DRY_RUN
      ? `\n━━━ DRY-RUN завершён. В Prisma НИЧЕГО не записано. Реальный прогон — отдельной командой ПОСЛЕ ревью этого отчёта:\n    tsx scripts/migrate-ytparser-to-prisma.ts\n`
      : `\n━━━ Миграция завершена. Проверьте паритет (Шаг 4) перед выпилом парсера.\n`,
  );
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
