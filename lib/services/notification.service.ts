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
  workspaceId: string | null;
  workspaceName: string | null;
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
  workspaceId?: string;
  extra?: { fromColumn?: string; toColumn?: string; commentText?: string };
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
      workspaceId: input.workspaceId ?? null,
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
          select: {
            title: true,
            description: true,
            priority: true,
            dueDate: true,
            column: { select: { name: true } },
            assignees: {
              include: { user: { select: { login: true } } },
            },
            checklistItems: { select: { checked: true } },
          },
        })
      : null,
    input.workspaceId
      ? db.workspace.findUnique({
          where: { id: input.workspaceId },
          select: { name: true },
        })
      : null,
  ]);

  const message = formatNotificationMessage({
    type: input.type,
    actorLogin: actor?.login ?? null,
    taskTitle: task?.title ?? null,
    projectName: project?.name ?? null, // kept as projectName for telegram template compat
    description: task?.description ?? null,
    priority: task?.priority ?? null,
    dueDate: task?.dueDate ?? null,
    columnName: task?.column?.name ?? null,
    assigneeLogins:
      task?.assignees
        ?.map((a) => a.user.login)
        .filter((l) => l !== actor?.login) ?? [],
    checklistTotal: task?.checklistItems?.length ?? 0,
    checklistDone: task?.checklistItems?.filter((i) => i.checked).length ?? 0,
    extra: input.extra,
  });

  // Fire-and-forget: don't await, don't block main flow
  void sendTelegramNotification(recipient.telegramChatId, message, {
    taskId: input.taskId,
  });
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
        workspace: { select: { name: true } },
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
      workspaceId: n.workspaceId,
      workspaceName: n.workspace?.name ?? null,
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
