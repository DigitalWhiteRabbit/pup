const express = require("express");
const crypto = require("crypto");
// Шаг 3.3b: роут переведён на db/prisma-store (единый Prisma-Postgres PUP).
const store = require("../db/prisma-store");
const { requireWsId } = require("../db/workspace-map");
const { adminAuth } = require("../utils/auth");
const email = require("../services/email");
const tg = require("../services/telegram-outreach");
const { localDateKey } = require("../utils/dates");
const router = express.Router();

const MAX_ADMIN_MESSAGE_LEN = 10000;
const DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";

// Зеркала хелперов outreach-worker (там они не экспортируются).
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

// Тема для ручного ответа. Конвенция та же, что у воркера (outreach-worker.js:909):
// тема берётся из ПЕРВОГО сообщения треда, иначе ручное письмо и автоответ по
// одному диалогу уйдут с разными темами.
function replySubject(messages, lead) {
  for (const m of messages) {
    let subject = null;
    try {
      subject = JSON.parse(m.metadata || "{}").subject || null;
    } catch {
      subject = null;
    }
    if (!subject) continue;
    return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
  }
  return `Re: ${lead?.channel_name || "Collaboration"}`;
}

// GET /api/dialogues  — список всех диалогов с превью
router.get("/", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const dialogues = await store.listAllDialogues(req.wsId);
  res.json({ success: true, dialogues });
});

// GET /api/dialogues/:id/messages
router.get("/:id/messages", async (req, res) => {
  if (!requireWsId(req, res)) return;
  const dialogue = await store.getDialogue(req.wsId, req.params.id);
  if (!dialogue)
    return res.status(404).json({ success: false, error: "not found" });
  // Показываем ВСЕ сообщения лида (по всем его диалогам), а не только этого
  // треда — иначе ответ блогера из старой ветки другой кампании не виден.
  const messages = await store.listMessagesByLead(req.wsId, dialogue.lead_id);
  const lead = await store.getLead(req.wsId, dialogue.lead_id);
  res.json({ success: true, dialogue, lead, messages });
});

// POST /api/dialogues/:id/admin-message  — админ шлёт сообщение от своего имени.
// Реально отправляет по каналу диалога (email через Resend, telegram тем же
// аккаунтом, что ведёт тред) и только потом пишет в БД: если отправка упала,
// сообщения в треде не будет, иначе админ видит галочку «отправлено» на письме,
// которого не существует. body.send=false — записать в историю без отправки
// (для писем, отправленных руками из почты).
router.post("/:id/admin-message", adminAuth, async (req, res) => {
  if (!requireWsId(req, res)) return;
  const { content, send } = req.body;
  if (!content)
    return res.status(400).json({ success: false, error: "content required" });
  if (typeof content !== "string" || content.length > MAX_ADMIN_MESSAGE_LEN) {
    return res.status(400).json({
      success: false,
      error: `content must be string <= ${MAX_ADMIN_MESSAGE_LEN} chars`,
    });
  }

  const dialogue = await store.getDialogue(req.wsId, req.params.id);
  if (!dialogue)
    return res.status(404).json({ success: false, error: "not found" });

  const logOnly = send === false;
  const metadata = { manual: true };
  let trackingId = null;

  if (!logOnly) {
    const lead = await store.getLead(req.wsId, dialogue.lead_id);
    if (!lead)
      return res.status(404).json({ success: false, error: "lead not found" });

    try {
      if (dialogue.channel === "email") {
        const to = parseEmailList(lead.email)[0];
        if (!to) throw new Error("у лида не заполнен email");
        // Только этот тред: listMessagesByLead отдаёт сообщения всех диалогов
        // лида, а In-Reply-To ниже берётся по dialogue.id — иначе тема уйдёт от
        // одного треда, а заголовок от другого.
        const messages = (
          await store.listMessagesByLead(req.wsId, lead.id)
        ).filter((m) => m.dialogue_id === dialogue.id);
        const subject = replySubject(messages, lead);
        metadata.subject = subject;

        if (DRY_RUN) {
          metadata.dry_run = true;
          metadata.resend_id = `dry-run-${Date.now()}`;
        } else {
          const replyToHeader = await store.getLastOutResendId(
            req.wsId,
            dialogue.id,
          );
          trackingId = generateTrackingId();
          const result = await email.sendEmail({
            to,
            subject,
            body: content,
            replyToHeader,
            leadId: lead.id, // GDPR: футер отписки, как во всех email-путях воркера
            trackingPixelUrl: buildTrackingPixelUrl(req.wsId, trackingId),
          });
          metadata.resend_id = result.id;
        }
      } else if (dialogue.channel === "telegram") {
        const recipient = parseTelegramHandle(lead.telegram);
        if (!recipient) throw new Error("у лида не заполнен telegram");

        if (DRY_RUN) {
          metadata.dry_run = true;
          metadata.tg_message_id = `dry-run-${Date.now()}`;
        } else {
          let accountId = await store.getDialogueAccountId(
            req.wsId,
            dialogue.id,
          );
          if (accountId == null) accountId = tg.pickAccount();
          if (accountId == null)
            throw new Error(
              "нет доступного TG-аккаунта (залогинен/под лимитом)",
            );
          const result = await tg.sendMessageVia(accountId, recipient, content);
          if (
            (await store.getDialogueAccountId(req.wsId, dialogue.id)) == null
          ) {
            await store.setDialogueAccount(
              req.wsId,
              result.accountId,
              dialogue.id,
            );
          }
          metadata.tg_message_id = result.messageId;
          metadata.chat_id = result.chatId;
          metadata.account_id = result.accountId;
        }
      } else {
        throw new Error(`неизвестный канал диалога: ${dialogue.channel}`);
      }
    } catch (e) {
      console.error("[dialogues] admin-message send failed:", e.message);
      return res.status(502).json({
        success: false,
        error: `отправка не удалась: ${e.message}`,
      });
    }
  }

  await store.insertMessage(req.wsId, {
    dialogue_id: dialogue.id,
    direction: "out",
    sender: "admin",
    content,
    metadata: JSON.stringify(metadata),
    resend_id: metadata.resend_id ?? null,
    created_at: new Date().toISOString(),
    tracking_id: trackingId,
  });

  // Дневные счётчики: ручное письмо тоже расходует дневной лимит домена,
  // иначе cap_email занижен (воркер делает это после каждой отправки).
  if (!logOnly && !metadata.dry_run) {
    await store
      .upsertDailyCounters(req.wsId, {
        date: localDateKey(),
        sent_email: dialogue.channel === "email" ? 1 : 0,
        sent_tg: dialogue.channel === "telegram" ? 1 : 0,
        ai_input_tokens: 0,
        ai_output_tokens: 0,
      })
      .catch((e) =>
        console.error("[dialogues] daily counters failed:", e.message),
      );
  }

  res.json({ success: true, sent: !logOnly, dryRun: !!metadata.dry_run });
});

module.exports = router;
