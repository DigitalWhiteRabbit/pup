import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from "@/lib/db";
import {
  MktLeadStatus,
  MktDialogueStage,
  MktMsgDirection,
  MktMsgSender,
  MktDealDecision,
  MktPendingStatus,
} from "@prisma/client";
import {
  generateInitialPitch,
  qualifyLead,
  generateReply,
  generateFollowUp,
  generateContentSummary,
  type PitchResult,
} from "./mkt-ai.service";
import {
  sendEmail,
  fetchInbox,
  isAutoReply,
  extractCleanText,
  markSeen,
} from "./mkt-email.service";
import { scoreLead } from "./mkt-scoring.service";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes — covers slow AI generation
const OUTREACH_INTERVAL_MS = 30 * 1000; // 30s between outreach ticks
const INBOX_INTERVAL_MS = 60 * 1000; // 60s between inbox checks
const DECISIONS_INTERVAL_MS = 15 * 1000; // 15s between decision checks
const FOLLOWUP_INTERVAL_MS = 5 * 60 * 1000; // 5min between followup checks
const LOG_BUFFER_MAX = 500;
const CIRCUIT_BREAKER_THRESHOLD = 10; // consecutive errors before auto-stop

// Default warm-up schedule: 14 days graduating from 5 to 200 emails/day
const DEFAULT_WARMUP_SCHEDULE = [
  5, 10, 20, 30, 50, 75, 100, 125, 150, 175, 200, 200, 200, 200,
];

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface WorkerState {
  running: boolean;
  workspaceId: string | null;
  outreachInterval: NodeJS.Timeout | null;
  inboxInterval: NodeJS.Timeout | null;
  decisionsInterval: NodeJS.Timeout | null;
  followUpInterval: NodeJS.Timeout | null;
  lastTick: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  stats: {
    sent: number;
    replied: number;
    errors: number;
    deals: number;
    skipped: number;
  };
}

export interface WorkerStatus {
  running: boolean;
  lastTick: string | null;
  lastError: string | null;
  stats: WorkerState["stats"];
  pendingCount: number;
  readyCount: number;
  inWorkCount: number;
  dailySentEmail: number;
  dailySentTg: number;
  reviewMode: boolean;
  dryRun: boolean;
  logCount: number;
  // Warm-up info
  warmupEnabled: boolean;
  warmupDay: number | null; // current day number (0-based), null if not active
  warmupLimit: number | null; // effective daily limit from warm-up schedule
  dailyCapEmail: number; // configured hard cap for reference
}

// ═══════════════════════════════════════════════════════════════════════════
// Module-level state (singleton in Next.js server process)
// ═══════════════════════════════════════════════════════════════════════════

const workerState: WorkerState = {
  running: false,
  workspaceId: null,
  outreachInterval: null,
  inboxInterval: null,
  decisionsInterval: null,
  followUpInterval: null,
  lastTick: null,
  lastError: null,
  consecutiveErrors: 0,
  stats: { sent: 0, replied: 0, errors: 0, deals: 0, skipped: 0 },
};

let isProcessingReplies = false;
let isProcessingApproved = false;
let isProcessingOutreach = false;
let isProcessingFollowUps = false;

const logBuffer: string[] = [];

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  const entry = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  }
  if (level === "error") {
    console.error(`[MKT-WORKER] ${msg}`);
  } else {
    console.log(`[MKT-WORKER] [${level}] ${msg}`);
  }
}

function getLogs(): string[] {
  return [...logBuffer];
}

/** Circuit breaker: track consecutive errors and auto-stop the worker. */
function recordTickSuccess(): void {
  workerState.consecutiveErrors = 0;
}

async function recordTickError(source: string, err: unknown): Promise<void> {
  workerState.consecutiveErrors++;
  workerState.stats.errors++;
  workerState.lastError = String(err);

  if (workerState.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
    log(
      "error",
      `CIRCUIT BREAKER: ${workerState.consecutiveErrors} consecutive errors (last from ${source}: ${err}). Auto-stopping worker to prevent runaway failures.`,
    );
    await stop();
  }
}

async function isReviewMode(workspaceId: string): Promise<boolean> {
  const config = await db.mktConfig.findUnique({
    where: { workspaceId },
    select: { reviewMode: true },
  });
  return config?.reviewMode ?? false;
}

async function isDryRun(workspaceId: string): Promise<boolean> {
  const config = await db.mktConfig.findUnique({
    where: { workspaceId },
    select: { dryRun: true },
  });
  return config?.dryRun ?? false;
}

async function getConfig(workspaceId: string) {
  const { getMktConfig } = await import("./mkt-config");
  return getMktConfig(workspaceId);
}

/**
 * Compute the effective daily email limit, respecting warm-up schedule.
 * When warm-up is enabled and a start date is set, the limit graduates
 * according to the schedule. The effective limit is always capped by
 * the configured dailyCapEmail hard ceiling.
 */
function getEffectiveDailyLimit(config: any): number {
  if (!config.warmupEnabled || !config.warmupStartDate) {
    return config.dailyCapEmail;
  }

  const startMs = new Date(config.warmupStartDate).getTime();
  const nowMs = Date.now();
  const daysSinceStart = Math.floor((nowMs - startMs) / 86_400_000);

  // Negative days means start date is in the future — use first day limit
  const dayIndex = Math.max(0, daysSinceStart);

  let schedule: number[];
  try {
    schedule = config.warmupSchedule
      ? JSON.parse(config.warmupSchedule)
      : DEFAULT_WARMUP_SCHEDULE;
  } catch {
    schedule = DEFAULT_WARMUP_SCHEDULE;
  }

  if (!Array.isArray(schedule) || schedule.length === 0) {
    schedule = DEFAULT_WARMUP_SCHEDULE;
  }

  const rawLimit =
    dayIndex < schedule.length
      ? schedule[dayIndex]
      : schedule[schedule.length - 1];
  const warmupLimit: number = rawLimit ?? (config.dailyCapEmail as number);

  return Math.min(warmupLimit, (config.dailyCapEmail as number) ?? 200);
}

/**
 * Return warm-up metadata for status reporting.
 */
function getWarmupInfo(config: any): {
  warmupEnabled: boolean;
  warmupDay: number | null;
  warmupLimit: number | null;
  dailyCapEmail: number;
} {
  const cap: number = (config.dailyCapEmail as number) ?? 200;

  if (!config.warmupEnabled || !config.warmupStartDate) {
    return {
      warmupEnabled: config.warmupEnabled ?? false,
      warmupDay: null,
      warmupLimit: null,
      dailyCapEmail: cap,
    };
  }

  const startMs = new Date(config.warmupStartDate).getTime();
  const daysSinceStart = Math.max(
    0,
    Math.floor((Date.now() - startMs) / 86_400_000),
  );

  let schedule: number[];
  try {
    schedule = config.warmupSchedule
      ? JSON.parse(config.warmupSchedule)
      : DEFAULT_WARMUP_SCHEDULE;
  } catch {
    schedule = DEFAULT_WARMUP_SCHEDULE;
  }

  if (!Array.isArray(schedule) || schedule.length === 0) {
    schedule = DEFAULT_WARMUP_SCHEDULE;
  }

  const rawLimit =
    daysSinceStart < schedule.length
      ? schedule[daysSinceStart]
      : schedule[schedule.length - 1];
  const warmupLimit: number = rawLimit ?? cap;

  return {
    warmupEnabled: true,
    warmupDay: daysSinceStart,
    warmupLimit: Math.min(warmupLimit, cap),
    dailyCapEmail: cap,
  };
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getDailyCounts(
  workspaceId: string,
): Promise<{ sent_email: number; sent_tg: number }> {
  const dateKey = todayKey();
  const counter = await db.mktDailyCounter.findUnique({
    where: { workspaceId_dateKey: { workspaceId, dateKey } },
  });
  return {
    sent_email: counter?.emailsSent ?? 0,
    sent_tg: counter?.tgSent ?? 0,
  };
}

async function incrementDailyCount(
  workspaceId: string,
  channel: string,
): Promise<void> {
  const dateKey = todayKey();
  const field = channel === "telegram" ? "tgSent" : "emailsSent";

  await db.mktDailyCounter.upsert({
    where: { workspaceId_dateKey: { workspaceId, dateKey } },
    create: {
      workspaceId,
      dateKey,
      [field]: 1,
    },
    update: {
      [field]: { increment: 1 },
    },
  });
}

async function getActiveProject(workspaceId: string) {
  return db.mktProject.findFirst({
    where: { workspaceId, isActive: true },
  });
}

function pickChannel(lead: any): string {
  // Prefer email, fall back to telegram
  if (lead.email) return "email";
  if (lead.telegram) return "telegram";
  return "email"; // default, will fail gracefully if no email
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Loop: processOutreachQueue
// ═══════════════════════════════════════════════════════════════════════════

async function processOutreachQueue(workspaceId: string): Promise<void> {
  if (isProcessingOutreach) {
    log("debug", "Outreach tick skipped — already processing");
    return;
  }
  isProcessingOutreach = true;

  try {
    workerState.lastTick = new Date().toISOString();

    // 1. Check active project
    const project = await getActiveProject(workspaceId);
    if (!project) {
      log("info", "No active project — skipping outreach tick");
      return;
    }

    // 2. Check daily caps (warm-up aware)
    const config = await getConfig(workspaceId);
    const daily = await getDailyCounts(workspaceId);

    const effectiveEmailCap = getEffectiveDailyLimit(config);
    const emailCapReached = daily.sent_email >= effectiveEmailCap;
    const tgCapReached = daily.sent_tg >= config.dailyCapTg;

    if (emailCapReached && tgCapReached) {
      const warmupDayStr =
        config.warmupEnabled && config.warmupStartDate
          ? ` (warmup day ${Math.max(0, Math.floor((Date.now() - new Date(config.warmupStartDate).getTime()) / 86_400_000)) + 1})`
          : "";
      log(
        "info",
        `Daily caps reached: email=${daily.sent_email}/${effectiveEmailCap}${warmupDayStr}, tg=${daily.sent_tg}/${config.dailyCapTg}`,
      );
      return;
    }

    // 3. Pick next READY lead (atomic: find + set lockedUntil)
    const lead = await db.$transaction(async (tx) => {
      const l = await tx.mktLead.findFirst({
        where: {
          workspaceId,
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          optedOut: false,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
        },
        orderBy: [{ leadScore: "desc" }, { createdAt: "asc" }],
      });

      if (!l) return null;

      await tx.mktLead.update({
        where: { id: l.id },
        data: {
          lockedUntil: new Date(Date.now() + LOCK_DURATION_MS),
          leadStatus: MktLeadStatus.IN_WORK,
          dialogueStage: MktDialogueStage.QUEUED,
        },
      });

      return l;
    });

    if (!lead) {
      log("debug", "No READY leads available");
      return;
    }

    log("info", `Processing lead: ${lead.channelName} (${lead.id})`);

    // 3b. Generate content summary if missing (gives AI full context about the lead)
    if (!lead.contentSummary) {
      try {
        log("info", `Generating content summary for ${lead.channelName}...`);
        const summary = await generateContentSummary(workspaceId, lead);
        if (summary) {
          await db.mktLead.update({
            where: { id: lead.id },
            data: { contentSummary: summary },
          });
          lead.contentSummary = summary;
          log("info", `Content summary generated for ${lead.channelName}`);
        }
      } catch (err) {
        log(
          "warn",
          `Summary generation failed for ${lead.channelName}: ${(err as Error).message}`,
        );
        // Continue without summary — not blocking
      }
    }

    // 4. Determine channel
    const channel = pickChannel(lead);
    const recipient = channel === "telegram" ? lead.telegram : lead.email;

    if (!recipient) {
      log("warn", `Lead ${lead.id} has no ${channel} contact — skipping`);
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          lockedUntil: null,
        },
      });
      workerState.stats.skipped++;
      return;
    }

    // Check channel-specific cap
    if (channel === "email" && emailCapReached) {
      log(
        "info",
        `Email cap reached, lead ${lead.id} only has email — releasing`,
      );
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          lockedUntil: null,
        },
      });
      return;
    }
    if (channel === "telegram" && tgCapReached) {
      log(
        "info",
        `TG cap reached, lead ${lead.id} only has telegram — releasing`,
      );
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          lockedUntil: null,
        },
      });
      return;
    }

    // 5. Run qualifyLead (get pitch angle — never rejects)
    try {
      const qualification = await qualifyLead(workspaceId, lead, project);

      log(
        "info",
        `Lead ${lead.channelName} qualified: suitable=${qualification.suitable}, angle: ${qualification.angle}`,
      );
    } catch (err) {
      log("error", `Qualify failed for ${lead.id}: ${err}`);
      // Don't reject — release back to queue
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          lockedUntil: null,
        },
      });
      workerState.stats.errors++;
      return;
    }

    // 5b. Select A/B variant (if enabled)
    let variantId: string | null = null;
    let variantInstructions: string | null = null;
    if (project.abTestEnabled && project.abVariants) {
      try {
        const variants = JSON.parse(project.abVariants);
        if (Array.isArray(variants) && variants.length > 0) {
          const variant = variants[Math.floor(Math.random() * variants.length)];
          variantId = variant.id;
          variantInstructions = variant.instructions || null;
          log(
            "info",
            `A/B test: selected variant "${variant.id}" (${variant.name}) for ${lead.channelName}`,
          );
        }
      } catch {
        log("warn", `Failed to parse abVariants for project ${project.id}`);
      }
    }

    // 6. Generate pitch via mkt-ai
    let pitch: PitchResult;
    try {
      pitch = await generateInitialPitch(
        workspaceId,
        lead,
        project,
        channel,
        null, // angle from qualification could be passed here
        variantInstructions,
      );
      log(
        "info",
        `Pitch generated for ${lead.channelName}: subject="${pitch.subject}" rewritten=${pitch._rewritten}${variantId ? ` variant=${variantId}` : ""}`,
      );
    } catch (err) {
      log("error", `Pitch generation failed for ${lead.id}: ${err}`);
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          lockedUntil: null,
        },
      });
      workerState.stats.errors++;
      return;
    }

    // 7. Check dry run
    const dryRun = await isDryRun(workspaceId);
    if (dryRun) {
      log(
        "info",
        `[DRY RUN] Would send to ${recipient} via ${channel}: "${pitch.subject}" — ${pitch.body.slice(0, 100)}...`,
      );
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          lockedUntil: null,
        },
      });
      workerState.stats.skipped++;
      return;
    }

    // 8. Check review mode
    const reviewMode = await isReviewMode(workspaceId);

    if (reviewMode) {
      // Create MktPendingReply for admin review
      await db.mktPendingReply.create({
        data: {
          leadId: lead.id,
          channel,
          recipient,
          subject: pitch.subject ?? undefined,
          body: pitch.body,
          context: JSON.stringify({
            type: "initial",
            projectId: project.id,
            projectName: project.name,
            channelName: lead.channelName,
            critique: pitch._critique,
            rewritten: pitch._rewritten,
            abVariantId: variantId,
          }),
          abVariantId: variantId,
          status: MktPendingStatus.PENDING,
        },
      });

      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          dialogueStage: MktDialogueStage.AWAITING_REVIEW,
          lockedUntil: null,
        },
      });

      log(
        "info",
        `Review mode: created pending reply for ${lead.channelName} (${channel})`,
      );
      return;
    }

    // 9. Send directly
    try {
      let sendResult: { id: string; messageId: string } | null = null;

      if (channel === "email") {
        sendResult = await sendEmail(workspaceId, {
          to: recipient,
          subject: pitch.subject || `Collaboration with ${project.name}`,
          body: pitch.body,
          leadId: lead.id,
        });
        log("info", `Email sent to ${recipient}, resendId=${sendResult.id}`);
      } else if (channel === "telegram") {
        // TODO: Implement Telegram sending via gramjs
        // await tg.sendMessage(recipient, pitch.body);
        log("info", `[TODO] Telegram message would be sent to ${recipient}`);
        sendResult = { id: `tg_${Date.now()}`, messageId: `tg_${Date.now()}` };
      }

      // 10. Create MktDialogue + MktMessage, update lead status
      const dialogue = await db.mktDialogue.create({
        data: {
          leadId: lead.id,
          channel,
          externalThreadId: sendResult?.messageId ?? null,
        },
      });

      await db.mktMessage.create({
        data: {
          dialogueId: dialogue.id,
          direction: MktMsgDirection.OUT,
          sender: MktMsgSender.AGENT,
          content: pitch.body,
          subject: pitch.subject,
          resendId: channel === "email" ? sendResult?.id : null,
          abVariantId: variantId,
          metadata: JSON.stringify({
            channel,
            critique: pitch._critique,
            rewritten: pitch._rewritten,
            abVariantId: variantId,
          }),
        },
      });

      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.IN_WORK,
          dialogueStage: MktDialogueStage.AWAITING_REPLY,
          lockedUntil: null,
        },
      });

      await incrementDailyCount(workspaceId, channel);
      workerState.stats.sent++;

      log(
        "info",
        `Outreach complete: ${lead.channelName} via ${channel}${variantId ? ` (variant ${variantId})` : ""}`,
      );
    } catch (err) {
      log("error", `Send failed for ${lead.id}: ${err}`);
      workerState.stats.errors++;
      workerState.lastError = String(err);

      // Release lead back
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          leadStatus: MktLeadStatus.READY,
          dialogueStage: MktDialogueStage.NOT_CONTACTED,
          lockedUntil: null,
        },
      });
    }
  } catch (err) {
    log("error", `Outreach tick error: ${err}`);
    workerState.stats.errors++;
    workerState.lastError = String(err);
  } finally {
    isProcessingOutreach = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Loop: processInbox
// ═══════════════════════════════════════════════════════════════════════════

async function processInbox(workspaceId: string): Promise<void> {
  if (isProcessingReplies) {
    log("debug", "Inbox tick skipped — already processing");
    return;
  }
  isProcessingReplies = true;

  try {
    // 1. Fetch emails via mkt-email.fetchInbox
    let messages;
    try {
      messages = await fetchInbox(workspaceId);
    } catch (err) {
      log("error", `fetchInbox failed: ${err}`);
      return;
    }

    if (messages.length === 0) {
      log("debug", "Inbox empty — no new messages");
      return;
    }

    log("info", `Inbox: ${messages.length} new message(s)`);

    for (const msg of messages) {
      try {
        // 2. Skip auto-replies
        if (isAutoReply(msg)) {
          log("info", `Skipping auto-reply from ${msg.from}: "${msg.subject}"`);
          await markSeen(workspaceId, msg.uid);
          continue;
        }

        // 3. Match to lead by email or reply headers
        let lead = null;

        // Try matching by In-Reply-To / References header (find our original message)
        if (msg.inReplyTo) {
          const originalMessage = await db.mktMessage.findFirst({
            where: { resendId: msg.inReplyTo },
            include: {
              dialogue: {
                include: { lead: true },
              },
            },
          });
          if (originalMessage) {
            lead = originalMessage.dialogue.lead;
          }
        }

        if (!lead && msg.references) {
          const refs = msg.references.split(/\s+/).filter(Boolean);
          for (const ref of refs) {
            const originalMessage = await db.mktMessage.findFirst({
              where: { resendId: ref },
              include: {
                dialogue: {
                  include: { lead: true },
                },
              },
            });
            if (originalMessage) {
              lead = originalMessage.dialogue.lead;
              break;
            }
          }
        }

        // Try matching by sender email
        if (!lead && msg.from) {
          // Check MktLeadEmail table first (fast lookup)
          const leadEmail = await db.mktLeadEmail.findFirst({
            where: {
              email: msg.from.toLowerCase(),
              lead: { workspaceId },
            },
            include: { lead: true },
          });
          if (leadEmail) {
            lead = leadEmail.lead;
          }

          // Fallback: check lead.email directly
          if (!lead) {
            lead = await db.mktLead.findFirst({
              where: {
                workspaceId,
                email: msg.from.toLowerCase(),
              },
            });
          }
        }

        if (!lead) {
          log(
            "warn",
            `No matching lead for email from ${msg.from} (subject: "${msg.subject}") — skipping`,
          );
          await markSeen(workspaceId, msg.uid);
          continue;
        }

        // 4. Find or create dialogue
        let dialogue = await db.mktDialogue.findFirst({
          where: {
            leadId: lead.id,
            channel: "email",
          },
          orderBy: { createdAt: "desc" },
        });

        if (!dialogue) {
          dialogue = await db.mktDialogue.create({
            data: {
              leadId: lead.id,
              channel: "email",
              externalThreadId: msg.messageId || null,
            },
          });
        }

        // Extract clean text (strip quoted replies)
        const cleanText = extractCleanText(msg.text);

        // 5. Insert MktMessage (direction: IN)
        await db.mktMessage.create({
          data: {
            dialogueId: dialogue.id,
            direction: MktMsgDirection.IN,
            sender: MktMsgSender.EXTERNAL,
            content: cleanText || msg.text,
            subject: msg.subject,
            metadata: JSON.stringify({
              uid: msg.uid,
              messageId: msg.messageId,
              inReplyTo: msg.inReplyTo,
              fromName: msg.fromName,
              date: msg.date,
            }),
          },
        });

        // Update lead stage
        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            dialogueStage: MktDialogueStage.REPLIED,
          },
        });

        workerState.stats.replied++;
        log(
          "info",
          `Incoming reply matched to lead ${lead.channelName} (${lead.id})`,
        );

        // Mark as seen in IMAP
        await markSeen(workspaceId, msg.uid);
      } catch (err) {
        log("error", `Error processing inbox message from ${msg.from}: ${err}`);
        workerState.stats.errors++;
      }
    }

    // 6. Generate pending replies for all leads with stage=replied
    await generatePendingReplies(workspaceId);
  } catch (err) {
    log("error", `Inbox tick error: ${err}`);
    workerState.stats.errors++;
    workerState.lastError = String(err);
  } finally {
    isProcessingReplies = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// generatePendingReplies
// ═══════════════════════════════════════════════════════════════════════════

async function generatePendingReplies(workspaceId: string): Promise<void> {
  const config = await getConfig(workspaceId);
  const maxReplies = config.maxRepliesPerTick;

  // Find leads with stage='replied' that need a response
  const leads = await db.mktLead.findMany({
    where: {
      workspaceId,
      dialogueStage: MktDialogueStage.REPLIED,
      optedOut: false,
    },
    take: maxReplies,
    orderBy: { updatedAt: "asc" },
  });

  if (leads.length === 0) return;

  log("info", `Generating replies for ${leads.length} lead(s)`);

  const project = await getActiveProject(workspaceId);

  for (const lead of leads) {
    try {
      // Get dialogue + history
      const dialogue = await db.mktDialogue.findFirst({
        where: { leadId: lead.id },
        orderBy: { createdAt: "desc" },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!dialogue || dialogue.messages.length === 0) {
        log("warn", `No dialogue found for lead ${lead.id} — skipping reply`);
        continue;
      }

      // Build history for AI
      const history = dialogue.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.content,
        subject: m.subject,
        createdAt: m.createdAt,
      }));

      const channel = dialogue.channel;

      // Generate AI reply
      const reply = await generateReply(
        workspaceId,
        lead,
        project,
        history,
        channel,
        null, // no admin directive
      );

      log(
        "info",
        `Reply generated for ${lead.channelName}: flag=${reply.flag}, price=${reply.extracted_price}`,
      );

      // Handle special flags
      if (reply.flag === "not_interested" || reply.flag === "spam") {
        log(
          "info",
          `Lead ${lead.channelName} flagged as ${reply.flag} — marking LOST`,
        );
        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            dialogueStage: MktDialogueStage.LOST,
          },
        });
        continue;
      }

      // Handle price_mentioned — escalate to deal
      if (reply.extracted_price && reply.extracted_price > 0 && project) {
        log(
          "info",
          `Price detected from ${lead.channelName}: ${reply.extracted_price} — creating deal`,
        );

        await db.mktDeal.create({
          data: {
            leadId: lead.id,
            projectId: project.id,
            proposedPrice: reply.extracted_price,
            agentSummary: `Блогер назвал цену: ${reply.extracted_price}. Флаг: ${reply.flag || "none"}.`,
            adminDecision: MktDealDecision.PENDING,
          },
        });

        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            dialogueStage: MktDialogueStage.DEAL_PENDING,
            agreedPrice: reply.extracted_price,
          },
        });

        workerState.stats.deals++;
        // Don't send reply yet — wait for admin decision on deal
        continue;
      }

      // Handle consultation_needed — escalate to admin
      if (reply.consultation_question) {
        log(
          "info",
          `Consultation needed for ${lead.channelName}: ${reply.consultation_question}`,
        );

        await db.mktConsultation.create({
          data: {
            leadId: lead.id,
            question: reply.consultation_question,
            context: JSON.stringify({
              lastMessage: history[history.length - 1]?.body,
              channelName: lead.channelName,
              flag: reply.flag,
            }),
            status: "pending",
          },
        });

        // Still generate the reply, but put in review mode
        const recipient = channel === "telegram" ? lead.telegram : lead.email;
        if (recipient) {
          await db.mktPendingReply.create({
            data: {
              leadId: lead.id,
              dialogueId: dialogue.id,
              channel,
              recipient,
              subject: reply.subject ?? undefined,
              body: reply.body,
              context: JSON.stringify({
                type: "reply",
                flag: reply.flag,
                consultation: reply.consultation_question,
                needsReview: true,
              }),
              status: MktPendingStatus.PENDING,
            },
          });
        }

        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            dialogueStage: MktDialogueStage.NEGOTIATING,
          },
        });
        continue;
      }

      // Normal reply flow
      const recipient = channel === "telegram" ? lead.telegram : lead.email;
      if (!recipient) {
        log(
          "warn",
          `Lead ${lead.id} has no ${channel} contact — skipping reply`,
        );
        continue;
      }

      const reviewMode = await isReviewMode(workspaceId);
      const dryRun = await isDryRun(workspaceId);

      if (dryRun) {
        log(
          "info",
          `[DRY RUN] Would reply to ${lead.channelName} via ${channel}: ${reply.body.slice(0, 100)}...`,
        );
        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            dialogueStage: MktDialogueStage.NEGOTIATING,
          },
        });
        continue;
      }

      if (reviewMode) {
        // Create pending reply for admin review
        await db.mktPendingReply.create({
          data: {
            leadId: lead.id,
            dialogueId: dialogue.id,
            channel,
            recipient,
            subject: reply.subject ?? undefined,
            body: reply.body,
            context: JSON.stringify({
              type: "reply",
              flag: reply.flag,
              extractedPrice: reply.extracted_price,
            }),
            status: MktPendingStatus.PENDING,
          },
        });

        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            dialogueStage: MktDialogueStage.AWAITING_REVIEW,
          },
        });

        log(
          "info",
          `Review mode: created pending reply to ${lead.channelName}`,
        );
      } else {
        // Send directly
        try {
          await sendReplyDirectly(
            workspaceId,
            lead,
            dialogue,
            reply,
            channel,
            recipient,
          );
        } catch (err) {
          log("error", `Send reply failed for ${lead.id}: ${err}`);
          workerState.stats.errors++;
        }
      }
    } catch (err) {
      log("error", `generatePendingReplies error for lead ${lead.id}: ${err}`);
      workerState.stats.errors++;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: send reply directly (no review)
// ═══════════════════════════════════════════════════════════════════════════

async function sendReplyDirectly(
  workspaceId: string,
  lead: any,
  dialogue: any,
  reply: PitchResult,
  channel: string,
  recipient: string,
): Promise<void> {
  let sendResult: { id: string; messageId: string } | null = null;

  // Get the last outgoing message for threading
  const lastOutMsg = await db.mktMessage.findFirst({
    where: {
      dialogueId: dialogue.id,
      direction: MktMsgDirection.OUT,
    },
    orderBy: { createdAt: "desc" },
  });

  if (channel === "email") {
    sendResult = await sendEmail(workspaceId, {
      to: recipient,
      subject:
        reply.subject || `Re: ${dialogue.externalThreadId || "Collaboration"}`,
      body: reply.body,
      replyToMessageId: lastOutMsg?.resendId ?? undefined,
      leadId: lead.id,
    });
    log("info", `Reply email sent to ${recipient}, resendId=${sendResult.id}`);
  } else if (channel === "telegram") {
    // TODO: Implement Telegram sending via gramjs
    // await tg.sendMessage(recipient, reply.body);
    log("info", `[TODO] Telegram reply would be sent to ${recipient}`);
    sendResult = { id: `tg_${Date.now()}`, messageId: `tg_${Date.now()}` };
  }

  // Record message
  await db.mktMessage.create({
    data: {
      dialogueId: dialogue.id,
      direction: MktMsgDirection.OUT,
      sender: MktMsgSender.AGENT,
      content: reply.body,
      subject: reply.subject,
      resendId: channel === "email" ? sendResult?.id : null,
      metadata: JSON.stringify({
        channel,
        flag: reply.flag,
      }),
    },
  });

  // Update lead stage
  await db.mktLead.update({
    where: { id: lead.id },
    data: {
      dialogueStage: MktDialogueStage.AWAITING_REPLY,
    },
  });

  await incrementDailyCount(workspaceId, channel);
  workerState.stats.sent++;

  log("info", `Reply sent to ${lead.channelName} via ${channel}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Loop: processDecidedDeals
// ═══════════════════════════════════════════════════════════════════════════

async function processDecidedDeals(workspaceId: string): Promise<void> {
  // Find MktDeals with decision != PENDING
  const deals = await db.mktDeal.findMany({
    where: {
      lead: { workspaceId },
      adminDecision: { not: MktDealDecision.PENDING },
      decidedAt: { not: null },
    },
    include: {
      lead: true,
      project: true,
    },
  });

  // Filter to only deals where the lead is still in DEAL_PENDING stage
  const actionableDeals = deals.filter(
    (d) => d.lead.dialogueStage === MktDialogueStage.DEAL_PENDING,
  );

  if (actionableDeals.length === 0) return;

  log("info", `Processing ${actionableDeals.length} decided deal(s)`);

  for (const deal of actionableDeals) {
    try {
      const lead = deal.lead;
      const project = deal.project;

      // Get dialogue
      const dialogue = await db.mktDialogue.findFirst({
        where: { leadId: lead.id },
        orderBy: { createdAt: "desc" },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
        },
      });

      if (!dialogue) {
        log("warn", `No dialogue for deal ${deal.id} lead ${lead.id}`);
        continue;
      }

      const history = dialogue.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.content,
        subject: m.subject,
        createdAt: m.createdAt,
      }));

      const channel = dialogue.channel;
      const recipient = channel === "telegram" ? lead.telegram : lead.email;

      if (!recipient) {
        log("warn", `Deal ${deal.id}: lead has no ${channel} contact`);
        continue;
      }

      // Build admin directive based on decision
      let adminDirective: string;
      if (deal.adminDecision === MktDealDecision.APPROVED) {
        adminDirective = `Менеджер ОДОБРИЛ сделку с этим блогером. Цена: ${deal.proposedPrice}₽.`;
        if (deal.adminNotes) {
          adminDirective += ` Заметки менеджера: ${deal.adminNotes}`;
        }
        adminDirective += ` Напиши блогеру, что мы согласны на условия и хотим двигаться дальше. Уточни детали: формат, сроки, ТЗ.`;
      } else {
        adminDirective = `Менеджер ОТКЛОНИЛ предложенную цену ${deal.proposedPrice}₽.`;
        if (deal.adminNotes) {
          adminDirective += ` Причина/заметки: ${deal.adminNotes}`;
        }
        adminDirective += ` Вежливо сообщи блогеру, что условия не подходят. Если есть заметки менеджера — используй их для обоснования.`;
      }

      // Generate response using AI
      const reply = await generateReply(
        workspaceId,
        lead,
        project,
        history,
        channel,
        adminDirective,
      );

      const reviewMode = await isReviewMode(workspaceId);
      const dryRun = await isDryRun(workspaceId);

      if (dryRun) {
        log(
          "info",
          `[DRY RUN] Deal response for ${lead.channelName}: ${reply.body.slice(0, 100)}...`,
        );
        continue;
      }

      if (reviewMode) {
        await db.mktPendingReply.create({
          data: {
            leadId: lead.id,
            dialogueId: dialogue.id,
            channel,
            recipient,
            subject: reply.subject ?? undefined,
            body: reply.body,
            context: JSON.stringify({
              type:
                deal.adminDecision === MktDealDecision.APPROVED
                  ? "deal_accept"
                  : "deal_reject",
              dealId: deal.id,
              price: deal.proposedPrice,
              adminNotes: deal.adminNotes,
            }),
            status: MktPendingStatus.PENDING,
          },
        });

        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            dialogueStage: MktDialogueStage.AWAITING_REVIEW,
          },
        });

        log(
          "info",
          `Review mode: created pending deal response for ${lead.channelName}`,
        );
      } else {
        // Send directly
        await sendReplyDirectly(
          workspaceId,
          lead,
          dialogue,
          reply,
          channel,
          recipient,
        );

        // Update stage based on decision
        const newStage =
          deal.adminDecision === MktDealDecision.APPROVED
            ? MktDialogueStage.WON
            : MktDialogueStage.LOST;

        await db.mktLead.update({
          where: { id: lead.id },
          data: { dialogueStage: newStage },
        });

        if (deal.adminDecision === MktDealDecision.APPROVED) {
          workerState.stats.deals++;
        }

        log(
          "info",
          `Deal ${deal.adminDecision} response sent to ${lead.channelName}`,
        );
      }
    } catch (err) {
      log("error", `processDecidedDeals error for deal ${deal.id}: ${err}`);
      workerState.stats.errors++;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Loop: processApprovedQueue
// ═══════════════════════════════════════════════════════════════════════════

async function processApprovedQueue(workspaceId: string): Promise<void> {
  if (isProcessingApproved) {
    log("debug", "Approved queue tick skipped — already processing");
    return;
  }
  isProcessingApproved = true;

  try {
    // Find MktPendingReply with status=APPROVED
    const approved = await db.mktPendingReply.findMany({
      where: {
        lead: { workspaceId },
        status: MktPendingStatus.APPROVED,
      },
      include: {
        lead: true,
        dialogue: true,
      },
      orderBy: { decidedAt: "asc" },
    });

    if (approved.length === 0) return;

    log("info", `Processing ${approved.length} approved pending repl(ies)`);

    for (const pending of approved) {
      try {
        const lead = pending.lead;
        const channel = pending.channel;
        const recipient = pending.recipient;

        // Use edited body/subject if provided
        const body = pending.editedBody || pending.body;
        const subject = pending.editedSubject || pending.subject;

        const dryRun = await isDryRun(workspaceId);
        if (dryRun) {
          log(
            "info",
            `[DRY RUN] Would send approved reply to ${recipient} via ${channel}`,
          );
          await db.mktPendingReply.update({
            where: { id: pending.id },
            data: { status: MktPendingStatus.SENT, sentAt: new Date() },
          });
          continue;
        }

        let sendResult: { id: string; messageId: string } | null = null;

        if (channel === "email") {
          // Get last outgoing message for threading
          let replyToMessageId: string | undefined;
          if (pending.dialogueId) {
            const lastOutMsg = await db.mktMessage.findFirst({
              where: {
                dialogueId: pending.dialogueId,
                direction: MktMsgDirection.OUT,
              },
              orderBy: { createdAt: "desc" },
            });
            replyToMessageId = lastOutMsg?.resendId ?? undefined;
          }

          sendResult = await sendEmail(workspaceId, {
            to: recipient,
            subject: subject || "Re: Collaboration",
            body,
            replyToMessageId,
            leadId: lead.id,
          });

          log(
            "info",
            `Approved email sent to ${recipient}, resendId=${sendResult.id}`,
          );
        } else if (channel === "telegram") {
          // TODO: Implement Telegram sending via gramjs
          log(
            "info",
            `[TODO] Telegram approved message would be sent to ${recipient}`,
          );
          sendResult = {
            id: `tg_${Date.now()}`,
            messageId: `tg_${Date.now()}`,
          };
        }

        // Get or create dialogue
        let dialogueId = pending.dialogueId;
        if (!dialogueId) {
          const dialogue = await db.mktDialogue.create({
            data: {
              leadId: lead.id,
              channel,
              externalThreadId: sendResult?.messageId ?? null,
            },
          });
          dialogueId = dialogue.id;
        }

        // Record message
        await db.mktMessage.create({
          data: {
            dialogueId,
            direction: MktMsgDirection.OUT,
            sender: MktMsgSender.AGENT,
            content: body,
            subject,
            resendId: channel === "email" ? sendResult?.id : null,
            abVariantId: pending.abVariantId ?? null,
            metadata: JSON.stringify({
              channel,
              pendingReplyId: pending.id,
              adminEdited: !!(pending.editedBody || pending.editedSubject),
              adminNotes: pending.adminNotes,
              abVariantId: pending.abVariantId,
            }),
          },
        });

        // Update pending reply status
        await db.mktPendingReply.update({
          where: { id: pending.id },
          data: {
            status: MktPendingStatus.SENT,
            sentAt: new Date(),
          },
        });

        // Update lead stage
        // Parse context to determine what type of message this was
        let contextData: any = {};
        try {
          contextData = pending.context ? JSON.parse(pending.context) : {};
        } catch {
          // ignore
        }

        let newStage: MktDialogueStage = MktDialogueStage.AWAITING_REPLY;
        if (contextData.type === "deal_accept") {
          newStage = MktDialogueStage.WON;
        } else if (contextData.type === "deal_reject") {
          newStage = MktDialogueStage.LOST;
        } else if (contextData.type === "initial") {
          newStage = MktDialogueStage.AWAITING_REPLY;
        }

        await db.mktLead.update({
          where: { id: lead.id },
          data: {
            leadStatus: MktLeadStatus.IN_WORK,
            dialogueStage: newStage,
            lockedUntil: null,
          },
        });

        await incrementDailyCount(workspaceId, channel);
        workerState.stats.sent++;

        log(
          "info",
          `Approved reply sent to ${lead.channelName} via ${channel}`,
        );
      } catch (err) {
        log(
          "error",
          `processApprovedQueue error for pending ${pending.id}: ${err}`,
        );
        workerState.stats.errors++;

        // Mark as failed
        await db.mktPendingReply.update({
          where: { id: pending.id },
          data: { status: MktPendingStatus.FAILED },
        });
      }
    }
  } catch (err) {
    log("error", `Approved queue tick error: ${err}`);
    workerState.stats.errors++;
    workerState.lastError = String(err);
  } finally {
    isProcessingApproved = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Loop: processFollowUps
// ═══════════════════════════════════════════════════════════════════════════

async function processFollowUps(workspaceId: string): Promise<void> {
  if (isProcessingFollowUps) {
    log("debug", "FollowUp tick skipped — already processing");
    return;
  }
  isProcessingFollowUps = true;

  try {
    const config = await getConfig(workspaceId);

    if (!config.followupEnabled) {
      log("debug", "Follow-ups disabled in config");
      return;
    }

    const delayDays = config.followupDelayDays;
    const maxAttempts = config.followupMaxAttempts;
    const cutoff = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000);

    // Find leads in AWAITING_REPLY or FOLLOWUP_* that haven't been followed up recently
    const leads = await db.mktLead.findMany({
      where: {
        workspaceId,
        leadStatus: MktLeadStatus.IN_WORK,
        dialogueStage: {
          in: [MktDialogueStage.AWAITING_REPLY, MktDialogueStage.FOLLOWUP_1],
        },
        optedOut: false,
        followupAttempts: { lt: maxAttempts },
        OR: [
          { lastFollowupAt: null, updatedAt: { lt: cutoff } },
          { lastFollowupAt: { lt: cutoff } },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: 5, // process up to 5 follow-ups per tick
    });

    if (leads.length === 0) {
      log("debug", "No leads due for follow-up");
      return;
    }

    log("info", `Processing ${leads.length} follow-up(s)`);

    const project = await getActiveProject(workspaceId);

    for (const lead of leads) {
      try {
        // Get dialogue + history
        const dialogue = await db.mktDialogue.findFirst({
          where: { leadId: lead.id },
          orderBy: { createdAt: "desc" },
          include: {
            messages: { orderBy: { createdAt: "asc" } },
          },
        });

        if (!dialogue) {
          log("warn", `No dialogue for follow-up lead ${lead.id}`);
          continue;
        }

        const history = dialogue.messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          body: m.content,
          subject: m.subject,
          createdAt: m.createdAt,
        }));

        const channel = dialogue.channel;
        const recipient = channel === "telegram" ? lead.telegram : lead.email;

        if (!recipient) {
          log("warn", `Follow-up lead ${lead.id} has no ${channel} contact`);
          continue;
        }

        const attempt = lead.followupAttempts + 1;

        // Generate follow-up
        const followUp = await generateFollowUp(
          workspaceId,
          lead,
          project,
          history,
          channel,
          attempt,
        );

        log("info", `Follow-up #${attempt} generated for ${lead.channelName}`);

        const reviewMode = await isReviewMode(workspaceId);
        const dryRun = await isDryRun(workspaceId);

        if (dryRun) {
          log(
            "info",
            `[DRY RUN] Follow-up #${attempt} for ${lead.channelName}: ${followUp.body.slice(0, 100)}...`,
          );
          await db.mktLead.update({
            where: { id: lead.id },
            data: {
              followupAttempts: attempt,
              lastFollowupAt: new Date(),
            },
          });
          continue;
        }

        if (reviewMode) {
          await db.mktPendingReply.create({
            data: {
              leadId: lead.id,
              dialogueId: dialogue.id,
              channel,
              recipient,
              subject: followUp.subject ?? undefined,
              body: followUp.body,
              context: JSON.stringify({
                type: "followup",
                attempt,
              }),
              status: MktPendingStatus.PENDING,
            },
          });

          await db.mktLead.update({
            where: { id: lead.id },
            data: {
              dialogueStage: MktDialogueStage.AWAITING_REVIEW,
              followupAttempts: attempt,
              lastFollowupAt: new Date(),
            },
          });

          log(
            "info",
            `Review mode: created pending follow-up #${attempt} for ${lead.channelName}`,
          );
        } else {
          // Send directly
          await sendReplyDirectly(
            workspaceId,
            lead,
            dialogue,
            followUp,
            channel,
            recipient,
          );

          // Determine follow-up stage
          let newStage: MktDialogueStage;
          if (attempt === 1) {
            newStage = MktDialogueStage.FOLLOWUP_1;
          } else if (attempt === 2) {
            newStage = MktDialogueStage.FOLLOWUP_2;
          } else {
            // Max follow-ups reached — mark as lost
            newStage = MktDialogueStage.LOST;
          }

          await db.mktLead.update({
            where: { id: lead.id },
            data: {
              dialogueStage: newStage,
              followupAttempts: attempt,
              lastFollowupAt: new Date(),
            },
          });

          log(
            "info",
            `Follow-up #${attempt} sent to ${lead.channelName} via ${channel}, stage → ${newStage}`,
          );
        }
      } catch (err) {
        log("error", `Follow-up error for lead ${lead.id}: ${err}`);
        workerState.stats.errors++;
      }
    }
  } catch (err) {
    log("error", `FollowUp tick error: ${err}`);
    workerState.stats.errors++;
    workerState.lastError = String(err);
  } finally {
    isProcessingFollowUps = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Control: start / stop / status / logs
// ═══════════════════════════════════════════════════════════════════════════

export async function start(workspaceId: string): Promise<void> {
  if (workerState.running) {
    log("warn", "Worker already running — ignoring start()");
    return;
  }

  log("info", `Starting worker for workspace ${workspaceId}`);

  workerState.running = true;
  workerState.workspaceId = workspaceId;
  workerState.lastError = null;
  workerState.consecutiveErrors = 0;
  workerState.stats = { sent: 0, replied: 0, errors: 0, deals: 0, skipped: 0 };

  // Outreach loop
  workerState.outreachInterval = setInterval(async () => {
    try {
      await processOutreachQueue(workspaceId);
      recordTickSuccess();
    } catch (err) {
      await recordTickError("outreach", err);
    }
  }, OUTREACH_INTERVAL_MS);

  // Inbox loop
  workerState.inboxInterval = setInterval(async () => {
    try {
      await processInbox(workspaceId);
      recordTickSuccess();
    } catch (err) {
      await recordTickError("inbox", err);
    }
  }, INBOX_INTERVAL_MS);

  // Decisions loop (also handles approved queue)
  workerState.decisionsInterval = setInterval(async () => {
    try {
      await processDecidedDeals(workspaceId);
      await processApprovedQueue(workspaceId);
      recordTickSuccess();
    } catch (err) {
      await recordTickError("decisions", err);
    }
  }, DECISIONS_INTERVAL_MS);

  // Follow-up loop
  workerState.followUpInterval = setInterval(async () => {
    try {
      await processFollowUps(workspaceId);
      recordTickSuccess();
    } catch (err) {
      await recordTickError("followup", err);
    }
  }, FOLLOWUP_INTERVAL_MS);

  // Run initial ticks immediately (staggered to avoid thundering herd)
  setTimeout(() => processOutreachQueue(workspaceId).catch(() => {}), 1000);
  setTimeout(() => processInbox(workspaceId).catch(() => {}), 3000);
  setTimeout(() => processDecidedDeals(workspaceId).catch(() => {}), 5000);
  setTimeout(() => processApprovedQueue(workspaceId).catch(() => {}), 7000);
  setTimeout(() => processFollowUps(workspaceId).catch(() => {}), 10000);

  log("info", "Worker started — all loops active");
}

export async function stop(): Promise<void> {
  if (!workerState.running) {
    log("warn", "Worker not running — ignoring stop()");
    return;
  }

  log("info", "Stopping worker...");

  if (workerState.outreachInterval) {
    clearInterval(workerState.outreachInterval);
    workerState.outreachInterval = null;
  }
  if (workerState.inboxInterval) {
    clearInterval(workerState.inboxInterval);
    workerState.inboxInterval = null;
  }
  if (workerState.decisionsInterval) {
    clearInterval(workerState.decisionsInterval);
    workerState.decisionsInterval = null;
  }
  if (workerState.followUpInterval) {
    clearInterval(workerState.followUpInterval);
    workerState.followUpInterval = null;
  }

  workerState.running = false;
  workerState.workspaceId = null;
  log("info", "Worker stopped");
}

export async function getStatus(workspaceId: string): Promise<WorkerStatus> {
  // Worker is singleton — only report running if it belongs to THIS workspace
  const isRunningForWorkspace =
    workerState.running && workerState.workspaceId === workspaceId;

  const [fullConfig, daily, pendingCount, readyCount, inWorkCount] =
    await Promise.all([
      db.mktConfig.findUnique({
        where: { workspaceId },
        select: {
          reviewMode: true,
          dryRun: true,
          warmupEnabled: true,
          warmupStartDate: true,
          warmupSchedule: true,
          dailyCapEmail: true,
        },
      }),
      getDailyCounts(workspaceId),
      db.mktPendingReply.count({
        where: {
          lead: { workspaceId },
          status: MktPendingStatus.PENDING,
        },
      }),
      db.mktLead.count({
        where: {
          workspaceId,
          leadStatus: MktLeadStatus.READY,
        },
      }),
      db.mktLead.count({
        where: {
          workspaceId,
          leadStatus: MktLeadStatus.IN_WORK,
        },
      }),
    ]);

  const warmupInfo = getWarmupInfo(
    fullConfig ?? { warmupEnabled: false, dailyCapEmail: 200 },
  );

  return {
    running: isRunningForWorkspace,
    lastTick: isRunningForWorkspace ? workerState.lastTick : null,
    lastError: isRunningForWorkspace ? workerState.lastError : null,
    stats: isRunningForWorkspace
      ? { ...workerState.stats }
      : { sent: 0, replied: 0, errors: 0, deals: 0, skipped: 0 },
    pendingCount,
    readyCount,
    inWorkCount,
    dailySentEmail: daily.sent_email,
    dailySentTg: daily.sent_tg,
    reviewMode: fullConfig?.reviewMode ?? false,
    dryRun: fullConfig?.dryRun ?? false,
    logCount: isRunningForWorkspace ? logBuffer.length : 0,
    ...warmupInfo,
  };
}

export async function getWorkerLogs(): Promise<string[]> {
  return getLogs();
}

// ═══════════════════════════════════════════════════════════════════════════
// Manual triggers: runLeadNow / onPendingReplyRejected
// ═══════════════════════════════════════════════════════════════════════════

export async function runLeadNow(
  workspaceId: string,
  leadId: string,
): Promise<void> {
  log("info", `runLeadNow: manually processing lead ${leadId}`);

  const lead = await db.mktLead.findFirst({
    where: { id: leadId, workspaceId },
  });

  if (!lead) {
    throw new Error(`Lead ${leadId} not found in workspace ${workspaceId}`);
  }

  const project = await getActiveProject(workspaceId);
  if (!project) {
    throw new Error("No active project");
  }

  // Score if not scored
  if (lead.leadScore == null) {
    log("info", `Scoring lead ${leadId} before outreach`);
    await scoreLead(workspaceId, leadId);
  }

  // Generate content summary if missing
  if (!lead.contentSummary) {
    try {
      log("info", `Generating content summary for ${lead.channelName}...`);
      const summary = await generateContentSummary(workspaceId, lead);
      if (summary) {
        await db.mktLead.update({
          where: { id: lead.id },
          data: { contentSummary: summary },
        });
        lead.contentSummary = summary;
        log("info", `Content summary generated for ${lead.channelName}`);
      }
    } catch (err) {
      log(
        "warn",
        `Summary generation failed for ${lead.channelName}: ${(err as Error).message}`,
      );
      // Continue without summary — not blocking
    }
  }

  // Determine channel
  const channel = pickChannel(lead);
  const recipient = channel === "telegram" ? lead.telegram : lead.email;

  if (!recipient) {
    throw new Error(`Lead ${leadId} has no contact for channel ${channel}`);
  }

  // Qualify
  const qualification = await qualifyLead(workspaceId, lead, project);
  log(
    "info",
    `runLeadNow qualification: suitable=${qualification.suitable}, reason=${qualification.reason}`,
  );

  if (!qualification.suitable) {
    // Still generate pitch even if not suitable — admin explicitly triggered
    log(
      "warn",
      `Lead ${leadId} failed qualification but proceeding (manual trigger): ${qualification.reason}`,
    );
  }

  // Select A/B variant (if enabled)
  let variantId: string | null = null;
  let variantInstructions: string | null = null;
  if (project.abTestEnabled && project.abVariants) {
    try {
      const variants = JSON.parse(project.abVariants);
      if (Array.isArray(variants) && variants.length > 0) {
        const variant = variants[Math.floor(Math.random() * variants.length)];
        variantId = variant.id;
        variantInstructions = variant.instructions || null;
        log(
          "info",
          `runLeadNow A/B test: selected variant "${variant.id}" (${variant.name})`,
        );
      }
    } catch {
      log("warn", `Failed to parse abVariants for project ${project.id}`);
    }
  }

  // Generate pitch
  const pitch = await generateInitialPitch(
    workspaceId,
    lead,
    project,
    channel,
    qualification.angle || null,
    variantInstructions,
  );

  const reviewMode = await isReviewMode(workspaceId);
  const dryRun = await isDryRun(workspaceId);

  if (dryRun) {
    log(
      "info",
      `[DRY RUN] runLeadNow: would send to ${recipient} via ${channel}: "${pitch.subject}"`,
    );
    return;
  }

  // Always use review mode for manual runs (safety net)
  if (reviewMode) {
    await db.mktPendingReply.create({
      data: {
        leadId: lead.id,
        channel,
        recipient,
        subject: pitch.subject ?? undefined,
        body: pitch.body,
        context: JSON.stringify({
          type: "initial",
          manual: true,
          projectId: project.id,
          projectName: project.name,
          channelName: lead.channelName,
          qualification,
          critique: pitch._critique,
          rewritten: pitch._rewritten,
          abVariantId: variantId,
        }),
        abVariantId: variantId,
        status: MktPendingStatus.PENDING,
      },
    });

    await db.mktLead.update({
      where: { id: lead.id },
      data: {
        leadStatus: MktLeadStatus.IN_WORK,
        dialogueStage: MktDialogueStage.AWAITING_REVIEW,
      },
    });

    log(
      "info",
      `runLeadNow: created pending reply for ${lead.channelName} — awaiting review`,
    );
    return;
  }
}

export async function onPendingReplyRejected(
  pendingReplyId: string,
): Promise<void> {
  log("info", `onPendingReplyRejected: ${pendingReplyId}`);

  const pending = await db.mktPendingReply.findUnique({
    where: { id: pendingReplyId },
    include: { lead: true },
  });

  if (!pending) {
    log("warn", `Pending reply ${pendingReplyId} not found`);
    return;
  }

  // Parse context to determine what to do
  let contextData: any = {};
  try {
    contextData = pending.context ? JSON.parse(pending.context) : {};
  } catch {
    // ignore
  }

  const lead = pending.lead;

  if (contextData.type === "initial") {
    // Initial outreach rejected — return lead to READY
    await db.mktLead.update({
      where: { id: lead.id },
      data: {
        leadStatus: MktLeadStatus.READY,
        dialogueStage: MktDialogueStage.NOT_CONTACTED,
        lockedUntil: null,
      },
    });
    log(
      "info",
      `Initial pitch rejected for ${lead.channelName} — returned to READY`,
    );
  } else if (contextData.type === "reply") {
    // Reply rejected — regenerate with admin notes as directive
    const adminNotes = pending.adminNotes;

    if (adminNotes) {
      log(
        "info",
        `Reply rejected for ${lead.channelName} with notes: "${adminNotes}" — regenerating`,
      );

      // Get workspace from lead
      const workspaceId = lead.workspaceId;
      const project = await getActiveProject(workspaceId);

      const dialogue = await db.mktDialogue.findFirst({
        where: { leadId: lead.id },
        orderBy: { createdAt: "desc" },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
        },
      });

      if (dialogue && project) {
        const history = dialogue.messages.map((m) => ({
          id: m.id,
          direction: m.direction,
          body: m.content,
          subject: m.subject,
          createdAt: m.createdAt,
        }));

        const reply = await generateReply(
          workspaceId,
          lead,
          project,
          history,
          dialogue.channel,
          adminNotes, // admin notes as directive
        );

        const recipient =
          dialogue.channel === "telegram" ? lead.telegram : lead.email;

        if (recipient) {
          await db.mktPendingReply.create({
            data: {
              leadId: lead.id,
              dialogueId: dialogue.id,
              channel: dialogue.channel,
              recipient,
              subject: reply.subject ?? undefined,
              body: reply.body,
              context: JSON.stringify({
                type: "reply",
                flag: reply.flag,
                regeneratedFrom: pendingReplyId,
                adminDirective: adminNotes,
              }),
              status: MktPendingStatus.PENDING,
            },
          });

          log(
            "info",
            `Regenerated reply for ${lead.channelName} with admin directive`,
          );
        }
      }
    } else {
      // No admin notes — just leave in current stage
      log(
        "info",
        `Reply rejected for ${lead.channelName} without notes — leaving in current stage`,
      );
      await db.mktLead.update({
        where: { id: lead.id },
        data: {
          dialogueStage: MktDialogueStage.REPLIED,
        },
      });
    }
  } else if (contextData.type === "followup") {
    // Follow-up rejected — leave lead in current stage, don't retry
    log("info", `Follow-up rejected for ${lead.channelName} — not retrying`);
  } else if (
    contextData.type === "deal_accept" ||
    contextData.type === "deal_reject"
  ) {
    // Deal response rejected — return to DEAL_PENDING for re-decision
    await db.mktLead.update({
      where: { id: lead.id },
      data: {
        dialogueStage: MktDialogueStage.DEAL_PENDING,
      },
    });
    log(
      "info",
      `Deal response rejected for ${lead.channelName} — returned to DEAL_PENDING`,
    );
  } else if (contextData.type === "consultation_answer") {
    // Consultation answer rejected — leave for admin to handle
    log("info", `Consultation answer rejected for ${lead.channelName}`);
  }
}
