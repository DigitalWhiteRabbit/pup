import "server-only";

import type { NotificationType } from "@prisma/client";

const BACKOFF_MS = [1000, 5000, 30000] as const;

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRIORITY_LABELS: Record<string, string> = {
  URGENT: "🔴 Срочный",
  HIGH: "🟠 Высокий",
  MEDIUM: "🟡 Средний",
  LOW: "🔵 Низкий",
};

export type NotificationPayload = {
  type: NotificationType;
  actorLogin: string | null;
  taskTitle: string | null;
  projectName: string | null;
  description?: string | null;
  priority?: string | null;
  dueDate?: Date | null;
  columnName?: string | null;
  assigneeLogins?: string[];
  checklistTotal?: number;
  checklistDone?: number;
  extra?: { fromColumn?: string; toColumn?: string; commentText?: string };
};

function formatDate(d: Date): string {
  return new Date(d).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function taskDetails(n: NotificationPayload): string[] {
  const lines: string[] = [];

  if (n.priority && PRIORITY_LABELS[n.priority]) {
    lines.push(`Приоритет: ${PRIORITY_LABELS[n.priority]}`);
  }

  if (n.dueDate) {
    lines.push(`⏰ Дедлайн: ${formatDate(n.dueDate)}`);
  }

  if (n.description) {
    const short =
      n.description.length > 100
        ? n.description.slice(0, 100) + "…"
        : n.description;
    lines.push(`📝 ${escapeHtml(short)}`);
  }

  if (n.checklistTotal && n.checklistTotal > 0) {
    lines.push(`☑️ Чек-лист: ${n.checklistDone ?? 0}/${n.checklistTotal}`);
  }

  if (n.assigneeLogins && n.assigneeLogins.length > 0) {
    lines.push(
      `👥 Также: ${n.assigneeLogins.map((l) => escapeHtml(l)).join(", ")}`,
    );
  }

  return lines;
}

export function formatNotificationMessage(n: NotificationPayload): string {
  const actor = n.actorLogin ? escapeHtml(n.actorLogin) : "Someone";
  const task = n.taskTitle ? escapeHtml(n.taskTitle) : "task";
  const project = n.projectName ? escapeHtml(n.projectName) : "project";

  switch (n.type) {
    case "ASSIGNED": {
      const lines = [
        `<b>📌 Назначение на задачу</b>`,
        `<b>${actor}</b> назначил вас на задачу:`,
        `<i>${task}</i>`,
        `Проект: ${project}`,
        ...taskDetails(n),
      ];
      return lines.join("\n");
    }
    case "COMMENTED": {
      const lines = [
        `<b>💬 Новый комментарий</b>`,
        `<b>${actor}</b> прокомментировал задачу:`,
        `<i>${task}</i>`,
        `Проект: ${project}`,
      ];
      if (n.extra?.commentText) {
        const short =
          n.extra.commentText.length > 200
            ? n.extra.commentText.slice(0, 200) + "…"
            : n.extra.commentText;
        lines.push(`\n«${escapeHtml(short)}»`);
      }
      return lines.join("\n");
    }
    case "MOVED": {
      const lines = [
        `<b>🔄 Задача перемещена</b>`,
        `<b>${actor}</b> переместил задачу:`,
        `<i>${task}</i>`,
      ];
      if (n.extra?.fromColumn && n.extra?.toColumn) {
        lines.push(
          `${escapeHtml(n.extra.fromColumn)} → ${escapeHtml(n.extra.toColumn)}`,
        );
      }
      lines.push(`Проект: ${project}`);
      return lines.join("\n");
    }
    case "PROJECT_ADDED":
      return [
        `<b>📁 Добавлен в проект</b>`,
        `<b>${actor}</b> добавил вас в проект:`,
        `<i>${project}</i>`,
      ].join("\n");
  }
}

export async function sendTelegramNotification(
  chatId: string,
  message: string,
  options?: { taskId?: string },
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
          ...(options?.taskId
            ? {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "💬 Ответить",
                        callback_data: `comment:${options.taskId}`,
                      },
                    ],
                  ],
                },
              }
            : {}),
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
