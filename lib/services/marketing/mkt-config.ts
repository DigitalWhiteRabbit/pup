import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from "@/lib/db";
import {
  decryptConfig,
  encryptConfigFields,
} from "@/lib/services/crypto.service";

/**
 * Load MktConfig for workspace with fallback to process.env.
 * If no MktConfig row exists, auto-creates one from env vars.
 * Sensitive fields (API keys, tokens, passwords) are decrypted on read.
 */
export async function getMktConfig(workspaceId: string) {
  let config = await db.mktConfig.findUnique({ where: { workspaceId } });

  if (!config) {
    // Auto-create from env fallback — encrypt secrets before storing
    const envSecrets = encryptConfigFields({
      youtubeApiKey: process.env.YOUTUBE_API_KEY ?? null,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
      apifyToken: process.env.APIFY_TOKEN ?? null,
      resendApiKey: process.env.RESEND_API_KEY ?? null,
      imapPass: process.env.IMAP_PASS ?? null,
      tgApiHash: process.env.TG_API_HASH ?? null,
      adminBotToken: process.env.ADMIN_BOT_TOKEN ?? null,
    });

    config = await db.mktConfig.create({
      data: {
        workspaceId,
        ...envSecrets,
        resendSenderEmail: process.env.EMAIL_FROM ?? null,
        resendSenderName: process.env.RESEND_SENDER_NAME ?? null,
        imapHost: process.env.IMAP_HOST ?? null,
        imapPort: process.env.IMAP_PORT
          ? parseInt(process.env.IMAP_PORT)
          : null,
        imapUser: process.env.IMAP_USER ?? null,
        tgApiId: process.env.TG_API_ID ?? null,
        tgPhone: process.env.TG_PHONE ?? null,
        adminTgChatId: process.env.ADMIN_TG_CHAT_ID ?? null,
      },
    });
  }

  // Decrypt sensitive fields (handles both encrypted and legacy plaintext)
  const decrypted = decryptConfig(config);

  // Fallback individual fields to env if null in DB
  return {
    ...decrypted,
    youtubeApiKey:
      decrypted.youtubeApiKey || process.env.YOUTUBE_API_KEY || null,
    anthropicApiKey:
      decrypted.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null,
    apifyToken: decrypted.apifyToken || process.env.APIFY_TOKEN || null,
    resendApiKey: decrypted.resendApiKey || process.env.RESEND_API_KEY || null,
    resendSenderEmail:
      decrypted.resendSenderEmail || process.env.EMAIL_FROM || null,
    imapHost: decrypted.imapHost || process.env.IMAP_HOST || null,
    imapPort:
      decrypted.imapPort ||
      (process.env.IMAP_PORT ? parseInt(process.env.IMAP_PORT) : null),
    imapUser: decrypted.imapUser || process.env.IMAP_USER || null,
    imapPass: decrypted.imapPass || process.env.IMAP_PASS || null,
    tgApiId: decrypted.tgApiId || process.env.TG_API_ID || null,
    tgApiHash: decrypted.tgApiHash || process.env.TG_API_HASH || null,
    adminBotToken:
      decrypted.adminBotToken || process.env.ADMIN_BOT_TOKEN || null,
    adminTgChatId:
      decrypted.adminTgChatId || process.env.ADMIN_TG_CHAT_ID || null,
  };
}
