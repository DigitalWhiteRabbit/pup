const TelegramBot = require("node-telegram-bot-api");
// Шаг 4b-2: admin-bot глобальный (одна TG-сессия на систему) → ws-agnostic store
// (deals/leads/consultations по глобальному cuid).
const store = require("../db/prisma-store");

let bot = null;
let adminChatId = null;

// In-memory mapping: bot_message_id → consultation_id (for reply tracking)
const consultationByMessage = new Map();

function init() {
  const token = process.env.ADMIN_BOT_TOKEN;
  adminChatId = process.env.ADMIN_TG_CHAT_ID;

  if (!token || !adminChatId) {
    console.log(
      "[admin-bot] ADMIN_BOT_TOKEN или ADMIN_TG_CHAT_ID не заданы — admin bot отключён",
    );
    return false;
  }

  if (bot) return true;

  try {
    // No polling — PUP main bot already uses polling on this token.
    // We only use sendMessage for outbound notifications.
    bot = new TelegramBot(token, { polling: false });
    console.log(
      "[admin-bot] Ready (send-only, no polling), admin chat: " + adminChatId,
    );
    return true;
  } catch (e) {
    console.error("[admin-bot] Failed to start:", e.message);
    return false;
  }
}

function isReady() {
  return !!bot;
}

// ─── Получатели уведомлений ────────────────────────────────────────
// Помимо основного ADMIN_TG_CHAT_ID (владелец) уведомления идут доп. людям,
// перечисленным по логину в ADMIN_NOTIFY_LOGINS (через запятую). Их chat id
// берётся из User.telegramChatId (бот общий с ПУП) и активируется автоматически,
// как только человек привяжет Telegram в основном приложении. Кэш 60с.
let _recipCache = { at: 0, ids: [] };
async function resolveRecipients() {
  const ids = new Set();
  if (adminChatId) ids.add(String(adminChatId));
  try {
    const now = Date.now();
    if (now - _recipCache.at > 60000) {
      _recipCache = {
        at: now,
        ids: await store.getMarketingNotifyChatIds(),
      };
    }
    for (const id of _recipCache.ids) ids.add(String(id));
  } catch (e) {
    console.error("[admin-bot] resolveRecipients:", e.message);
  }
  return [...ids];
}

// Доп. получатели без основного admin (для info-копий интерактивных сообщений).
async function extraRecipients() {
  return (await resolveRecipients()).filter(
    (id) => String(id) !== String(adminChatId),
  );
}

// Разослать информационное уведомление всем получателям.
async function broadcast(text, options = {}) {
  const recips = await resolveRecipients();
  for (const chatId of recips) {
    try {
      await safeSend(chatId, text, options);
    } catch (e) {
      // Один заблокировавший бота получатель не должен рвать рассылку остальным.
      console.error("[admin-bot] broadcast to " + chatId + ":", e.message);
    }
  }
}

// ─── Escaping (HTML parse_mode) ────────────────────────────────────

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Validate youtube URL
function isValidYouTubeUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// Safe send with HTML parse_mode + fallback to plain text
async function safeSend(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...options,
    });
  } catch (e) {
    console.error("[admin-bot] HTML send failed, retrying plain:", e.message);
    try {
      // Strip tags for plain fallback
      const plain = text.replace(/<[^>]+>/g, "");
      return await bot.sendMessage(chatId, plain, {
        ...options,
        parse_mode: undefined,
      });
    } catch (e2) {
      console.error("[admin-bot] plain send also failed:", e2.message);
      throw e2;
    }
  }
}

function setupHandlers() {
  bot.onText(/\/start/, (msg) => {
    const text = `Привет! Я бот-уведомитель AI Outreach Agent.\nТвой chat_id: <code>${escapeHtml(msg.chat.id)}</code>\n\nЯ буду присылать тебе:\n• Сделки на approval\n• Консультации от AI агента\n\nКоманды:\n/status — статус агента\n/pending — список сделок на approval`;
    safeSend(msg.chat.id, text);
  });

  bot.onText(/\/status/, async (msg) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    try {
      const counts = await store.countAllLeadsByStatus();
      const pendingDeals = await store.countAllPendingDeals();
      const pendingConsults = await store.countAllPendingConsultations();
      const text =
        `<b>Статус системы</b>\n\n` +
        `Лиды: ${counts.total} (pending: ${counts.pending || 0}, ready: ${counts.ready || 0}, in work: ${counts.in_work || 0})\n` +
        `Сделки на approval: ${pendingDeals}\n` +
        `Консультации в ожидании: ${pendingConsults}`;
      await safeSend(msg.chat.id, text);
    } catch (e) {
      await safeSend(msg.chat.id, "Ошибка: " + escapeHtml(e.message));
    }
  });

  bot.onText(/\/pending/, async (msg) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    const deals = await store.listAllPendingDeals();
    if (deals.length === 0) {
      safeSend(msg.chat.id, "Нет сделок на approval");
      return;
    }
    for (const deal of deals) await sendDealNotification(deal);
  });

  bot.on("callback_query", async (q) => {
    if (String(q.message.chat.id) !== String(adminChatId)) return;
    const data = q.data || "";
    // dealId — cuid (раньше int)
    const m = data.match(/^deal:(approve|reject):([a-z0-9]+)$/);
    if (!m) {
      bot.answerCallbackQuery(q.id, { text: "Unknown action" });
      return;
    }

    const action = m[1];
    const dealId = m[2];
    const now = new Date().toISOString();
    await store.decideDealById(
      dealId,
      action === "approve" ? "approved" : "rejected",
      null,
      now,
    );

    bot.answerCallbackQuery(q.id, {
      text: action === "approve" ? "Approved" : "Rejected",
    });
    bot
      .editMessageReplyMarkup(
        {
          inline_keyboard: [
            [
              {
                text: action === "approve" ? "Approved" : "Rejected",
                callback_data: "noop",
              },
            ],
          ],
        },
        { chat_id: q.message.chat.id, message_id: q.message.message_id },
      )
      .catch(() => {});
  });

  bot.on("message", async (msg) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;
    if (!msg.reply_to_message) return;
    if (msg.text && msg.text.startsWith("/")) return;

    const consultationId = consultationByMessage.get(
      msg.reply_to_message.message_id,
    );
    if (!consultationId) return;

    const now = new Date().toISOString();
    await store.answerConsultationById(consultationId, msg.text, now);

    safeSend(
      msg.chat.id,
      "Ответ сохранён, агент использует его в следующем сообщении.",
      { reply_to_message_id: msg.message_id },
    );
    consultationByMessage.delete(msg.reply_to_message.message_id);
  });

  bot.on("polling_error", (e) =>
    console.error("[admin-bot polling]", e.message),
  );
}

// ─── Notifications ───────────────────────────────────────────────

async function sendDealNotification(deal) {
  if (!bot || !adminChatId) return;
  const lead = await store.getLeadById(deal.lead_id);
  if (!lead) return;

  const urlValid = isValidYouTubeUrl(lead.channel_url);
  const channelLink = urlValid
    ? `<a href="${escapeHtml(lead.channel_url)}">${escapeHtml(lead.channel_name || "?")}</a>`
    : escapeHtml(lead.channel_name || "?");

  const text =
    `<b>Сделка готова к approval</b>\n\n` +
    `<b>Канал:</b> ${channelLink}\n` +
    `<b>Подписчики:</b> ${(lead.subscribers || 0).toLocaleString("ru")}\n` +
    `<b>Страна:</b> ${escapeHtml(lead.country || "?")}\n` +
    `<b>Цена:</b> ${(deal.proposed_price || 0).toLocaleString("ru")} ₽\n\n` +
    `<b>Сводка диалога:</b>\n${escapeHtml(deal.agent_summary || "(нет)")}`;

  try {
    await safeSend(adminChatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `deal:approve:${deal.id}` },
            { text: "Reject", callback_data: `deal:reject:${deal.id}` },
          ],
        ],
      },
    });
    // Доп. получателям — инфо-копия без кнопок (approve/reject делает владелец).
    for (const chatId of await extraRecipients()) {
      try {
        await safeSend(chatId, text);
      } catch (e) {
        console.error("[admin-bot] deal copy to " + chatId + ":", e.message);
      }
    }
  } catch (e) {
    console.error("[admin-bot] Failed to send deal notification:", e.message);
  }
}

async function askConsultation(consultation, lead) {
  if (!bot || !adminChatId) return;

  let contextHtml = "";
  try {
    const ctx = JSON.parse(consultation.context || "[]");
    const lines = ctx.map(
      (m) =>
        `${m.direction === "in" ? "БЛОГЕР" : "АГЕНТ"}: ${escapeHtml(String(m.content || "").slice(0, 200))}`,
    );
    if (lines.length)
      contextHtml = `\n\n<b>Контекст:</b>\n<pre>${lines.join("\n\n")}</pre>`;
  } catch {}

  const text =
    `<b>AI агенту нужна консультация</b>\n\n` +
    `<b>Лид:</b> ${escapeHtml(lead?.channel_name || "?")}\n` +
    `<b>Вопрос:</b> ${escapeHtml(consultation.question)}` +
    contextHtml +
    `\n\n<i>Reply на это сообщение чтобы ответить агенту.</i>`;

  try {
    // Рассылаем всем маркетинг-получателям; связь message_id → консультация пишем
    // в БД, чтобы reply из любого чата обработал основной бот (общий токен).
    const recips = await resolveRecipients();
    const pairs = [];
    for (const chatId of recips) {
      try {
        const sent = await safeSend(chatId, text, {
          reply_markup: { force_reply: true, selective: true },
        });
        if (sent?.message_id) {
          pairs.push({ chatId: String(chatId), messageId: sent.message_id });
        }
      } catch (e) {
        // Пропускаем сбойного получателя, остальные всё равно получат и смогут ответить.
        console.error("[admin-bot] consultation to " + chatId + ":", e.message);
      }
    }
    if (pairs.length)
      await store.setConsultationTgMessages(consultation.id, pairs);
  } catch (e) {
    console.error("[admin-bot] Failed to send consultation:", e.message);
  }
}

async function notifyText(text) {
  if (!bot || !adminChatId) return;
  try {
    await broadcast(escapeHtml(text));
  } catch (e) {
    console.error("[admin-bot] notify failed:", e.message);
  }
}

// Уведомление о новом pending_reply в Review mode.
// Просто текст, детальный review через UI (редактирование не удобно в TG).
async function notifyPendingReply(pr) {
  if (!bot || !adminChatId) return;
  try {
    let ctx = {};
    try {
      ctx = JSON.parse(pr.context || "{}");
    } catch {}
    const typeLabel =
      {
        initial: "первое сообщение",
        reply: "ответ",
        deal_accept: "сделка",
        consultation_answer: "после консультации",
      }[ctx.type] ||
      ctx.type ||
      "";
    const text =
      `🕑 <b>Ответ на проверке</b> [${escapeHtml(typeLabel)}]\n` +
      `<b>Канал:</b> ${escapeHtml(pr.channel)}\n` +
      `<b>Кому:</b> ${escapeHtml(pr.recipient || "")}\n` +
      (pr.subject ? `<b>Тема:</b> ${escapeHtml(pr.subject)}\n` : "") +
      `\n<pre>${escapeHtml(String(pr.body || "").slice(0, 600))}</pre>\n` +
      `\n<i>Открой веб-интерфейс «На проверке» чтобы одобрить/отредактировать.</i>`;
    await broadcast(text);
  } catch (e) {
    console.error("[admin-bot] notifyPendingReply failed:", e.message);
  }
}

module.exports = {
  init,
  isReady,
  sendDealNotification,
  askConsultation,
  notifyText,
  notifyPendingReply,
};
