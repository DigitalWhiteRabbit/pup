import "server-only";

import { db } from "@/lib/db";
import type { CardChannel } from "@/lib/content/constants";

// ─────────────────────────────────────────────────────────────────────────────
// АВТОПУБЛИКАЦИЯ (задел, phase 2)
//
// Архитектура: провайдер на канал. Гарантированно автоматизируется Telegram
// (Bot API). Остальные каналы (Instagram/Facebook через Meta Graph, X/TikTok/
// YouTube) — интерфейс заложен, реализация по мере доступности API; по умолчанию
// публикация ручная (карточка остаётся READY, ссылку проставляет SMM вручную).
//
// Автопубликация ВЫКЛЮЧЕНА по умолчанию: срабатывает только для карточек с
// autoPublish=true, status=READY и наступившей датой, и только если для канала
// есть настроенный провайдер. Триггерится кроном (см. app/api/cron/...).
// ─────────────────────────────────────────────────────────────────────────────

export type PublishResult = { externalId?: string; url?: string };

export interface ContentPublishProvider {
  readonly channel: CardChannel;
  /** Опубликовать карточку. Бросает ошибку, если канал не настроен. */
  publish(input: {
    workspaceId: string;
    cardId: string;
    title: string;
    text: string | null;
  }): Promise<PublishResult>;
}

// ─── Telegram-провайдер (первый рабочий канал) ────────────────────────────────

/**
 * Целевой чат/канал Telegram для воркспейса хранится в MktSetting
 * (ключ "content.tg.channelId") — переиспользуем существующую key-value таблицу.
 */
async function resolveTgChannel(workspaceId: string): Promise<string | null> {
  const setting = await db.mktSetting.findUnique({
    where: { workspaceId_key: { workspaceId, key: "content.tg.channelId" } },
    select: { value: true },
  });
  return setting?.value ?? null;
}

const telegramProvider: ContentPublishProvider = {
  channel: "TELEGRAM",
  async publish({ workspaceId, title, text }) {
    const token = process.env["TELEGRAM_BOT_TOKEN"];
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");

    const chatId = await resolveTgChannel(workspaceId);
    if (!chatId)
      throw new Error(
        "Не настроен Telegram-канал (MktSetting content.tg.channelId)",
      );

    const body = text?.trim() ? text : title;
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: body }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Telegram API ${res.status}: ${errText}`);
    }
    const data = (await res.json()) as {
      result?: { message_id?: number };
    };
    const messageId = data.result?.message_id;
    const chatRef = chatId.replace(/^@/, "");
    return {
      externalId: messageId ? String(messageId) : undefined,
      url: messageId ? `https://t.me/${chatRef}/${messageId}` : undefined,
    };
  },
};

// ─── Реестр провайдеров ────────────────────────────────────────────────────────
// TODO (phase 2): INSTAGRAM/FACEBOOK через Meta Graph API; X/TIKTOK/YOUTUBE —
// по мере доступности API. Пока отсутствие провайдера = ручная публикация.

const PROVIDERS: Partial<Record<CardChannel, ContentPublishProvider>> = {
  TELEGRAM: telegramProvider,
};

export function getProvider(
  channel: CardChannel,
): ContentPublishProvider | null {
  return PROVIDERS[channel] ?? null;
}

// ─── Воркер ────────────────────────────────────────────────────────────────────

export type AutoPublishSummary = {
  attempted: number;
  published: number;
  skippedNoProvider: number;
  errors: Array<{ cardId: string; error: string }>;
};

/**
 * Найти карточки, готовые к автопубликации, и опубликовать их через провайдера.
 * Идемпотентно: публикует только READY + autoPublish + дата наступила + ещё не
 * опубликовано (publishedExternalId IS NULL).
 */
export async function runAutoPublish(
  now: Date = new Date(),
): Promise<AutoPublishSummary> {
  const due = await db.contentCard.findMany({
    where: {
      status: "READY",
      autoPublish: true,
      publishedExternalId: null,
      publishDate: { lte: now },
    },
    select: {
      id: true,
      workspaceId: true,
      authorId: true,
      title: true,
      text: true,
      channel: true,
    },
  });

  const summary: AutoPublishSummary = {
    attempted: due.length,
    published: 0,
    skippedNoProvider: 0,
    errors: [],
  };

  for (const card of due) {
    const provider = getProvider(card.channel);
    if (!provider) {
      // Канал без автопубликации — оставляем на ручную (TODO: phase 2)
      summary.skippedNoProvider++;
      console.info(
        `[content/autopublish] канал ${card.channel} без провайдера — ручная публикация (card=${card.id})`,
      );
      continue;
    }
    try {
      const result = await provider.publish({
        workspaceId: card.workspaceId,
        cardId: card.id,
        title: card.title,
        text: card.text,
      });
      await db.$transaction([
        db.contentCard.update({
          where: { id: card.id },
          data: {
            status: "PUBLISHED",
            publishedUrl: result.url ?? null,
            publishedExternalId: result.externalId ?? `auto-${card.id}`,
          },
        }),
        db.contentCardHistory.create({
          data: {
            cardId: card.id,
            // системное действие записывается от имени автора карточки
            userId: card.authorId,
            action: "опубликовано (автопубликация)",
          },
        }),
      ]);
      summary.published++;
    } catch (e) {
      summary.errors.push({
        cardId: card.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return summary;
}
