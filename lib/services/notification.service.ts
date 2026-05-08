import "server-only";

import { db } from "@/lib/db";
import type { NotificationType } from "@prisma/client";
import {
  sendTelegramNotification,
  formatNotificationMessage,
} from "./telegram/sender";

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationItem = {
  id: string;
  type: NotificationType;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  actorLogin: string | null;
  isRead: boolean;
  createdAt: Date;
};

export interface GetNotificationsOptions {
  unreadOnly?: boolean;
  page?: number;
  limit?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type TgPrefKey =
  | "tgNotifyAssign"
  | "tgNotifyComment"
  | "tgNotifyMove"
  | "tgNotifyProject";

const TG_PREF_MAP: Record<NotificationType, TgPrefKey> = {
  ASSIGNED: "tgNotifyAssign",
  COMMENTED: "tgNotifyComment",
  MOVED: "tgNotifyMove",
  PROJECT_ADDED: "tgNotifyProject",
};

// ─── notify ───────────────────────────────────────────────────────────────────

export async function notify(input: {
  type: NotificationType;
  recipientId: string;
  actorId: string;
  taskId?: string;
  projectId?: string;
}): Promise<void> {
  // FR-029: no self-notifications
  if (input.recipientId === input.actorId) return;

  // 1. Create in-app notification (always)
  await db.notification.create({
    data: {
      type: input.type,
      recipientId: input.recipientId,
      actorId: input.actorId,
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
    },
  });

  // 2. Telegram dispatch (fire-and-forget)
  const recipient = await db.user.findUnique({
    where: { id: input.recipientId },
    select: {
      telegramChatId: true,
      tgNotifyAssign: true,
      tgNotifyComment: true,
      tgNotifyMove: true,
      tgNotifyProject: true,
    },
  });

  if (!recipient?.telegramChatId) return;

  const prefKey = TG_PREF_MAP[input.type];
  if (!recipient[prefKey]) return;

  // Gather info for message template
  const [actor, task, project] = await Promise.all([
    input.actorId
      ? db.user.findUnique({
          where: { id: input.actorId },
          select: { login: true },
        })
      : null,
    input.taskId
      ? db.task.findUnique({
          where: { id: input.taskId },
          select: { title: true, projectId: true },
        })
      : null,
    input.projectId
      ? db.project.findUnique({
          where: { id: input.projectId },
          select: { name: true },
        })
      : null,
  ]);

  const message = formatNotificationMessage({
    type: input.type,
    actorLogin: actor?.login ?? null,
    taskTitle: task?.title ?? null,
    projectName: project?.name ?? null,
  });

  // Fire-and-forget: don't await, don't block main flow
  void sendTelegramNotification(recipient.telegramChatId, message);
}

// ─── getNotifications ─────────────────────────────────────────────────────────

export async function getNotifications(
  userId: string,
  opts?: GetNotificationsOptions,
): Promise<{ data: NotificationItem[]; total: number; unreadCount: number }> {
  const page = opts?.page ?? 1;
  const limit = opts?.limit ?? 20;
  const skip = (page - 1) * limit;

  const where = {
    recipientId: userId,
    ...(opts?.unreadOnly ? { isRead: false } : {}),
  };

  const [notifications, total, unreadCount] = await db.$transaction([
    db.notification.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        actor: { select: { login: true } },
        task: { select: { title: true } },
        project: { select: { name: true } },
      },
    }),
    db.notification.count({ where }),
    db.notification.count({
      where: { recipientId: userId, isRead: false },
    }),
  ]);

  return {
    data: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      taskId: n.taskId,
      taskTitle: n.task?.title ?? null,
      projectId: n.projectId,
      projectName: n.project?.name ?? null,
      actorLogin: n.actor?.login ?? null,
      isRead: n.isRead,
      createdAt: n.createdAt,
    })),
    total,
    unreadCount,
  };
}

// ─── markAsRead ───────────────────────────────────────────────────────────────

export async function markAsRead(
  notificationIds: string[],
  userId: string,
): Promise<{ count: number }> {
  const result = await db.notification.updateMany({
    where: {
      id: { in: notificationIds },
      recipientId: userId,
    },
    data: { isRead: true },
  });

  return { count: result.count };
}

// ─── markAllAsRead ────────────────────────────────────────────────────────────

export async function markAllAsRead(
  userId: string,
): Promise<{ count: number }> {
  const result = await db.notification.updateMany({
    where: { recipientId: userId, isRead: false },
    data: { isRead: true },
  });

  return { count: result.count };
}

// ─── getUnreadCount ───────────────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  return db.notification.count({
    where: { recipientId: userId, isRead: false },
  });
}
