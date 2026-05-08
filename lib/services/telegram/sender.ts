import "server-only";

import type { NotificationType } from "@prisma/client";

const BACKOFF_MS = [1000, 5000, 30000] as const;

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type NotificationPayload = {
  type: NotificationType;
  actorLogin: string | null;
  taskTitle: string | null;
  projectName: string | null;
};

export function formatNotificationMessage(n: NotificationPayload): string {
  const actor = n.actorLogin ? escapeHtml(n.actorLogin) : "Someone";
  const task = n.taskTitle ? escapeHtml(n.taskTitle) : "task";
  const project = n.projectName ? escapeHtml(n.projectName) : "project";

  switch (n.type) {
    case "ASSIGNED":
      return [
        `<b>Назначение на задачу</b>`,
        `<b>${actor}</b> назначил вас на задачу:`,
        `<i>${task}</i>`,
        `Проект: ${project}`,
      ].join("\n");
    case "COMMENTED":
      return [
        `<b>Новый комментарий</b>`,
        `<b>${actor}</b> прокомментировал задачу:`,
        `<i>${task}</i>`,
        `Проект: ${project}`,
      ].join("\n");
    case "MOVED":
      return [
        `<b>Задача перемещена</b>`,
        `<b>${actor}</b> переместил задачу:`,
        `<i>${task}</i>`,
        `Проект: ${project}`,
      ].join("\n");
    case "PROJECT_ADDED":
      return [
        `<b>Добавлен в проект</b>`,
        `<b>${actor}</b> добавил вас в проект:`,
        `<i>${project}</i>`,
      ].join("\n");
  }
}

export async function sendTelegramNotification(
  chatId: string,
  message: string,
): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    console.error("[Telegram] TELEGRAM_BOT_TOKEN not set, skipping send");
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      });

      if (res.ok) return;

      const body = await res.text();
      lastError = new Error(`Telegram API ${res.status}: ${body}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }

  console.error(
    `[Telegram] Failed to send after 3 attempts. chatId=${chatId}`,
    lastError,
  );
}
