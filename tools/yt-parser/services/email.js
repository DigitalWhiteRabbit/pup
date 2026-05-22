const { Resend } = require("resend");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY не задан в .env");
  resendClient = new Resend(key);
  return resendClient;
}

/**
 * Отправить email через Resend.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.body
 * @param {string} [opts.replyToMessageId]
 * @param {string} [opts.replyToHeader]
 * @param {number} [opts.leadId] — если задан, в footer добавляется ссылка отписки
 * @returns {Promise<{id, messageId}>}
 */
/**
 * Convert plain text to simple HTML (escape + linkify + newlines).
 */
function textToHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>',
    )
    .replace(/\n/g, "<br>\n");
}

async function sendEmail({
  to,
  subject,
  body,
  replyToMessageId,
  replyToHeader,
  leadId,
  trackingPixelUrl,
}) {
  const resend = getResend();
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM не задан в .env");

  // Unsubscribe footer (GDPR)
  let finalBody = body;
  if (leadId) {
    try {
      const { generateUnsubscribeToken } = require("./unsubscribe");
      const baseUrl = (
        process.env.BASE_URL ||
        process.env.PUBLIC_DOMAIN ||
        ""
      ).replace(/\/$/, "");
      if (baseUrl) {
        const token = generateUnsubscribeToken(leadId);
        finalBody =
          body +
          `\n\n---\nНе интересно? Отписаться: ${baseUrl}/unsubscribe?token=${token}&id=${leadId}`;
      }
    } catch (e) {
      console.error("[email] unsubscribe footer failed:", e.message);
    }
  }

  // Build HTML version with tracking pixel
  let htmlBody = null;
  if (trackingPixelUrl) {
    htmlBody =
      textToHtml(finalBody) +
      `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none;width:1px;height:1px;border:0" alt="" />`;
  }

  const headers = {};
  if (replyToHeader) {
    headers["In-Reply-To"] = replyToHeader;
    headers["References"] = replyToHeader;
  }

  // Retry с backoff на 429/5xx
  const delays = [1000, 3000, 9000];
  let lastErr = null;
  for (let i = 0; i <= delays.length; i++) {
    try {
      const sendPayload = {
        from,
        to: [to],
        subject,
        text: finalBody,
        headers,
      };
      // Include HTML with tracking pixel if available
      if (htmlBody) sendPayload.html = htmlBody;

      const result = await resend.emails.send(sendPayload);
      if (result.error) {
        const code = result.error.statusCode || result.error.status;
        const retryable = code === 429 || (code >= 500 && code < 600);
        if (retryable && i < delays.length) {
          await new Promise((r) => setTimeout(r, delays[i]));
          lastErr = new Error("Resend: " + JSON.stringify(result.error));
          continue;
        }
        throw new Error("Resend error: " + JSON.stringify(result.error));
      }
      return {
        id: result.data?.id,
        messageId: result.data?.id, // Resend id используется как identifier для In-Reply-To матчинга
      };
    } catch (e) {
      lastErr = e;
      const code = e.status || e.statusCode;
      if ((code === 429 || (code >= 500 && code < 600)) && i < delays.length) {
        await new Promise((r) => setTimeout(r, delays[i]));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("Resend: unknown failure");
}

/**
 * Получить новые непрочитанные письма из IMAP inbox.
 * НЕ помечает \Seen — это делается явно через markSeen() после успешной обработки.
 * Возвращает массив {uid, from, subject, text, messageId, inReplyTo, references, date, headers}.
 */
async function fetchInbox() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!host || !user || !pass) {
    throw new Error(
      "IMAP credentials не заданы в .env (IMAP_HOST, IMAP_USER, IMAP_PASS)",
    );
  }

  const client = new ImapFlow({
    host,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const messages = [];
  await client.connect();

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      for await (const msg of client.fetch(
        { seen: false },
        { source: true, uid: true, envelope: true },
      )) {
        try {
          const parsed = await simpleParser(msg.source);
          const autoSubmitted = (parsed.headers?.get("auto-submitted") || "")
            .toString()
            .toLowerCase();
          messages.push({
            uid: msg.uid,
            from: (parsed.from?.value?.[0]?.address || "").toLowerCase().trim(),
            fromName: parsed.from?.value?.[0]?.name || "",
            to: parsed.to?.value?.[0]?.address || "",
            subject: parsed.subject || "",
            text: extractCleanText(parsed.text || parsed.html || ""),
            messageId: parsed.messageId || "",
            inReplyTo: parsed.inReplyTo || "",
            references: parsed.references || "",
            autoSubmitted,
            date: parsed.date?.toISOString() || new Date().toISOString(),
          });
        } catch (e) {
          console.error("[email] Failed to parse message:", e.message);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return messages;
}

/**
 * Пометить письмо \Seen по UID. Вызывается после успешного сохранения в БД.
 */
async function markSeen(uid) {
  if (!uid) return;
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error("[email] markSeen failed for uid", uid, e.message);
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

/**
 * Auto-reply detection. Возвращает true если письмо — автоответ.
 */
function isAutoReply(msg) {
  if (!msg) return false;
  const auto = String(msg.autoSubmitted || "").toLowerCase();
  if (auto && auto !== "no") return true;
  const subject = String(msg.subject || "");
  return /(out of office|автоответ|ooo\b|vacation|otsutstvuyu|отсутствую)/i.test(
    subject,
  );
}

/**
 * Очистить текст ответа от quoted reply (--- Original Message ---, > lines)
 */
function extractCleanText(text) {
  if (!text) return "";
  let cleaned = String(text);

  // Удаляем "On <date> <person> wrote:" и всё после
  cleaned = cleaned.split(/\n\s*On\s+.+\s+wrote:/i)[0];
  // Удаляем "From: ..." блоки
  cleaned = cleaned.split(/\n\s*From:\s+.+/i)[0];
  // Удаляем строки начинающиеся с >
  cleaned = cleaned
    .split("\n")
    .filter((l) => !l.trim().startsWith(">"))
    .join("\n");
  // Trim
  return cleaned.trim();
}

/**
 * Тестовое подключение к IMAP без чтения
 */
async function testImapConnection() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });
  await client.connect();
  await client.logout();
  return true;
}

module.exports = {
  sendEmail,
  fetchInbox,
  markSeen,
  isAutoReply,
  testImapConnection,
  extractCleanText,
};
