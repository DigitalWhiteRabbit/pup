import "server-only";

import { db } from "@/lib/db";
import { checkModuleAccess } from "@/lib/module-access";
import { sendTelegramNotification } from "@/lib/services/telegram/sender";
import type { NotificationType } from "@prisma/client";
import type { CardAction } from "@/lib/content/types";

export type ContentNotifyInput = {
  workspaceId: string;
  actorId: string;
  cardId: string;
  authorId: string;
  kind: CardAction;
  title: string;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Тип уведомления для каждого действия (или null — без уведомления). */
function notifyTypeFor(kind: CardAction): NotificationType | null {
  switch (kind) {
    case "review":
      return "CONTENT_REVIEW";
    case "request-changes":
      return "CONTENT_CHANGES";
    case "approve":
      return "CONTENT_APPROVED";
    default:
      return null; // approve-visual / publish — без уведомления
  }
}

/** Список userId модераторов воркспейса (OWNER или content:moderate). */
async function getModeratorIds(workspaceId: string): Promise<string[]> {
  const members = await db.workspaceMember.findMany({
    where: { workspaceId },
    select: { userId: true, role: true, allowedModules: true },
  });
  const ids: string[] = [];
  for (const m of members) {
    if (m.role === "OWNER") {
      ids.push(m.userId);
      continue;
    }
    let allowed: string[] | null = null;
    if (m.allowedModules) {
      try {
        const parsed = JSON.parse(m.allowedModules) as unknown;
        if (Array.isArray(parsed)) allowed = parsed as string[];
      } catch {
        /* full access */
      }
    }
    if (checkModuleAccess(allowed, "content:moderate")) ids.push(m.userId);
  }
  return ids;
}

function formatMessage(
  type: NotificationType,
  actorLogin: string,
  title: string,
  workspaceName: string,
): string {
  const t = escapeHtml(title);
  const ws = escapeHtml(workspaceName);
  const actor = escapeHtml(actorLogin);
  switch (type) {
    case "CONTENT_REVIEW":
      return [
        "<b>📝 Карточка на вычитку</b>",
        `<b>${actor}</b> отправил карточку на вычитку:`,
        `<i>${t}</i>`,
        `Проект: ${ws}`,
      ].join("\n");
    case "CONTENT_CHANGES":
      return [
        "<b>✏️ Вернули на правки</b>",
        `<b>${actor}</b> вернул карточку на доработку:`,
        `<i>${t}</i>`,
      ].join("\n");
    case "CONTENT_APPROVED":
      return [
        "<b>✅ Карточка одобрена</b>",
        `<b>${actor}</b> одобрил карточку:`,
        `<i>${t}</i>`,
      ].join("\n");
    default:
      return t;
  }
}

/**
 * Уведомления по событиям контент-плана (бейдж в панели + Telegram).
 * Триггеры: review → модераторам; request-changes / approve → автору.
 */
export async function notifyContentEvent(
  input: ContentNotifyInput,
): Promise<void> {
  const type = notifyTypeFor(input.kind);
  if (!type) return;

  // Получатели
  let recipientIds: string[];
  if (type === "CONTENT_REVIEW") {
    recipientIds = await getModeratorIds(input.workspaceId);
  } else {
    recipientIds = [input.authorId];
  }
  recipientIds = Array.from(new Set(recipientIds)).filter(
    (id) => id !== input.actorId,
  );
  if (recipientIds.length === 0) return;

  // 1. In-app уведомления (бейдж)
  await db.notification.createMany({
    data: recipientIds.map((recipientId) => ({
      type,
      recipientId,
      actorId: input.actorId,
      cardId: input.cardId,
      workspaceId: input.workspaceId,
    })),
  });

  // 2. Telegram (для тех, у кого подключён и включён тумблер)
  const [actor, workspace, recipients] = await Promise.all([
    db.user.findUnique({
      where: { id: input.actorId },
      select: { login: true },
    }),
    db.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { name: true },
    }),
    db.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, telegramChatId: true, tgNotifyContent: true },
    }),
  ]);

  const message = formatMessage(
    type,
    actor?.login ?? "Коллега",
    input.title,
    workspace?.name ?? "",
  );

  for (const r of recipients) {
    if (!r.telegramChatId || !r.tgNotifyContent) continue;
    void sendTelegramNotification(r.telegramChatId, message);
  }
}
