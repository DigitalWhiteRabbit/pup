import "server-only";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { db } from "@/lib/db";

/**
 * Load MktConfig for workspace with fallback to process.env.
 * If no MktConfig row exists, auto-creates one from env vars.
 */
export async function getMktConfig(workspaceId: string) {
  let config = await db.mktConfig.findUnique({ where: { workspaceId } });

  if (!config) {
    // Auto-create from env fallback
    config = await db.mktConfig.create({
      data: {
        workspaceId,
        youtubeApiKey: process.env.YOUTUBE_API_KEY ?? null,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
        apifyToken: process.env.APIFY_TOKEN ?? null,
        resendApiKey: process.env.RESEND_API_KEY ?? null,
        resendSenderEmail: process.env.EMAIL_FROM ?? null,
        resendSenderName: process.env.RESEND_SENDER_NAME ?? null,
        imapHost: process.env.IMAP_HOST ?? null,
        imapPort: process.env.IMAP_PORT
          ? parseInt(process.env.IMAP_PORT)
          : null,
        imapUser: process.env.IMAP_USER ?? null,
        imapPass: process.env.IMAP_PASS ?? null,
        tgApiId: process.env.TG_API_ID ?? null,
        tgApiHash: process.env.TG_API_HASH ?? null,
        tgPhone: process.env.TG_PHONE ?? null,
        adminBotToken: process.env.ADMIN_BOT_TOKEN ?? null,
        adminTgChatId: process.env.ADMIN_TG_CHAT_ID ?? null,
      },
    });
  }

  // Fallback individual fields to env if null in DB
  return {
    ...config,
    youtubeApiKey: config.youtubeApiKey || process.env.YOUTUBE_API_KEY || null,
    anthropicApiKey:
      config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null,
    apifyToken: config.apifyToken || process.env.APIFY_TOKEN || null,
    resendApiKey: config.resendApiKey || process.env.RESEND_API_KEY || null,
    resendSenderEmail:
      config.resendSenderEmail || process.env.EMAIL_FROM || null,
    imapHost: config.imapHost || process.env.IMAP_HOST || null,
    imapPort:
      config.imapPort ||
      (process.env.IMAP_PORT ? parseInt(process.env.IMAP_PORT) : null),
    imapUser: config.imapUser || process.env.IMAP_USER || null,
    imapPass: config.imapPass || process.env.IMAP_PASS || null,
    tgApiId: config.tgApiId || process.env.TG_API_ID || null,
    tgApiHash: config.tgApiHash || process.env.TG_API_HASH || null,
    adminBotToken: config.adminBotToken || process.env.ADMIN_BOT_TOKEN || null,
    adminTgChatId: config.adminTgChatId || process.env.ADMIN_TG_CHAT_ID || null,
  };
}
