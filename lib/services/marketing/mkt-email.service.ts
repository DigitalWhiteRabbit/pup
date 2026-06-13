import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any */

// FROZEN 2026-06-13: маркетинговый движок выведен из эксплуатации; единый источник
// outreach — yt-parser против общего Postgres. Не запускать как второго писателя.
// Удаление — после прод-стабилизации миграции. См. _docs/marketing-engine-audit.md.

// NOTE: imapflow and mailparser need to be installed:
//   pnpm add imapflow mailparser
//   pnpm add -D @types/mailparser
import { Resend } from "resend";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboxMessage {
  uid: number;
  from: string;
  fromName: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  autoSubmitted: string;
  date: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RETRY_DELAYS = [1000, 3000, 9000];

async function loadConfig(workspaceId: string) {
  const { getMktConfig } = await import("./mkt-config");
  return getMktConfig(workspaceId);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// sendEmail — Resend API with retry + backoff on 429/5xx
// ---------------------------------------------------------------------------

export async function sendEmail(
  workspaceId: string,
  opts: {
    to: string;
    subject: string;
    body: string;
    replyToMessageId?: string;
    replyToHeader?: string;
    leadId?: string;
  },
): Promise<{ id: string; messageId: string }> {
  const config = await loadConfig(workspaceId);

  if (!config.resendApiKey) {
    throw new Error("Resend API key not configured");
  }
  if (!config.resendSenderEmail) {
    throw new Error("Resend sender email not configured");
  }

  const resend = new Resend(config.resendApiKey);

  let html = opts.body;

  // Append unsubscribe footer if leadId is provided
  if (opts.leadId) {
    // TODO: implement proper unsubscribe token generation & verification
    const unsubscribeLink = `#unsubscribe-${opts.leadId}`;
    html += `
      <br/><hr style="margin-top:32px;border:none;border-top:1px solid #e5e5e5;"/>
      <p style="font-size:12px;color:#999;margin-top:8px;">
        <a href="${unsubscribeLink}" style="color:#999;">Отписаться</a> от рассылки.
      </p>
    `;
  }

  const senderName = config.resendSenderName || "ПУП";
  const from = `${senderName} <${config.resendSenderEmail}>`;

  const headers: Record<string, string> = {};
  if (opts.replyToMessageId) {
    headers["In-Reply-To"] = opts.replyToMessageId;
    headers["References"] = opts.replyToMessageId;
  }
  if (opts.replyToHeader) {
    headers["Reply-To"] = opts.replyToHeader;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const result = await resend.emails.send({
        from,
        to: [opts.to],
        subject: opts.subject,
        html,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }

      return {
        id: result.data?.id ?? "",
        messageId: result.data?.id ?? "",
      };
    } catch (err: unknown) {
      lastError = err;

      // Determine if retryable (429 or 5xx)
      const status =
        err instanceof Error && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 0;
      const isRetryable = status === 429 || status >= 500;

      if (!isRetryable || attempt >= RETRY_DELAYS.length) {
        break;
      }

      await sleep(RETRY_DELAYS[attempt]!);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// fetchInbox — IMAP inbox polling via imapflow + mailparser
// ---------------------------------------------------------------------------

export async function fetchInbox(workspaceId: string): Promise<InboxMessage[]> {
  const config = await loadConfig(workspaceId);

  if (!config.imapHost || !config.imapUser || !config.imapPass) {
    throw new Error("IMAP credentials not configured");
  }

  // Dynamic imports — these packages need to be installed separately
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort || 993,
    secure: true,
    auth: {
      user: config.imapUser,
      pass: config.imapPass,
    },
    logger: false,
  });

  const messages: InboxMessage[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      // Fetch unseen messages
      const uids = await client.search({ seen: false });

      if (uids.length === 0) {
        return messages;
      }

      for await (const msg of client.fetch(uids, {
        source: true,
        uid: true,
      })) {
        try {
          const parsed = await simpleParser(msg.source);

          const fromAddr = parsed.from?.value?.[0];
          messages.push({
            uid: msg.uid,
            from: fromAddr?.address || "",
            fromName: fromAddr?.name || "",
            subject: parsed.subject || "",
            text: parsed.text || "",
            messageId: parsed.messageId || "",
            inReplyTo:
              (typeof parsed.inReplyTo === "string"
                ? parsed.inReplyTo
                : Array.isArray(parsed.inReplyTo)
                  ? parsed.inReplyTo[0]
                  : "") || "",
            references:
              (typeof parsed.references === "string"
                ? parsed.references
                : Array.isArray(parsed.references)
                  ? parsed.references.join(" ")
                  : "") || "",
            autoSubmitted:
              (parsed.headers?.get("auto-submitted") as string) || "",
            date: parsed.date?.toISOString() || new Date().toISOString(),
          });
        } catch {
          // Skip unparseable messages
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return messages;
}

// ---------------------------------------------------------------------------
// markSeen — mark email as read by UID
// ---------------------------------------------------------------------------

export async function markSeen(
  workspaceId: string,
  uid: number,
): Promise<void> {
  const config = await loadConfig(workspaceId);

  if (!config.imapHost || !config.imapUser || !config.imapPass) {
    throw new Error("IMAP credentials not configured");
  }

  const { ImapFlow } = await import("imapflow");

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort || 993,
    secure: true,
    auth: {
      user: config.imapUser,
      pass: config.imapPass,
    },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      await client.messageFlagsAdd({ uid }, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// isAutoReply — detect auto-reply / out-of-office emails
// ---------------------------------------------------------------------------

export function isAutoReply(msg: InboxMessage): boolean {
  // Check Auto-Submitted header
  if (msg.autoSubmitted && msg.autoSubmitted !== "no") {
    return true;
  }

  // Check subject patterns
  const subjectLower = (msg.subject || "").toLowerCase();
  const autoPatterns = [
    "auto-reply",
    "autoreply",
    "automatic reply",
    "out of office",
    "out-of-office",
    "away from office",
    "vacation reply",
    "absence",
    "автоответ",
    "вне офиса",
    "нет на месте",
  ];

  return autoPatterns.some((p) => subjectLower.includes(p));
}

// ---------------------------------------------------------------------------
// extractCleanText — strip quoted replies from email body
// ---------------------------------------------------------------------------

export function extractCleanText(text: string): string {
  if (!text) return "";

  const lines = text.split("\n");
  const cleanLines: string[] = [];

  for (const line of lines) {
    // Stop at "On ... wrote:" pattern
    if (/^On .+ wrote:$/i.test(line.trim())) break;

    // Stop at "From: ..." pattern (Outlook-style quote header)
    if (/^From:\s/.test(line.trim())) break;

    // Stop at "-------- Original Message --------" or similar
    if (/^-{3,}\s*(Original Message|Forwarded)/i.test(line.trim())) break;

    // Skip lines starting with > (quoted text)
    if (/^>/.test(line.trim())) continue;

    cleanLines.push(line);
  }

  return cleanLines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// testImapConnection — verify IMAP credentials
// ---------------------------------------------------------------------------

export async function testImapConnection(
  workspaceId: string,
): Promise<boolean> {
  const config = await loadConfig(workspaceId);

  if (!config.imapHost || !config.imapUser || !config.imapPass) {
    return false;
  }

  const { ImapFlow } = await import("imapflow");

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort || 993,
    secure: true,
    auth: {
      user: config.imapUser,
      pass: config.imapPass,
    },
    logger: false,
  });

  try {
    await client.connect();
    await client.logout();
    return true;
  } catch {
    return false;
  }
}
