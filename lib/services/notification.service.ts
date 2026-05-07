import "server-only";
// TODO: Real implementation in T061 (US6 Phase 8)

export type NotifyType = "ASSIGNED" | "COMMENTED" | "MOVED" | "PROJECT_ADDED";

export interface GetNotificationsOptions {
  unreadOnly?: boolean;
  page?: number;
  limit?: number;
}

export interface NotificationItem {
  id: string;
  type: NotifyType;
  taskId: string | null;
  projectId: string | null;
  isRead: boolean;
  createdAt: Date;
}

/**
 * Stub: sends a notification to a recipient.
 * No-op until T061.
 */
export async function notify(
  _type: NotifyType,
  _recipientId: string,
  _actorId: string,
  _taskId?: string,
  _projectId?: string,
): Promise<void> {
  // TODO: implement in T061 (US6 Phase 8)
  // Will persist Notification to DB and dispatch Telegram transport
}

/**
 * Stub: returns notifications for a user.
 * Returns empty array until T061.
 */
export async function getNotifications(
  _userId: string,
  _opts?: GetNotificationsOptions,
): Promise<NotificationItem[]> {
  // TODO: implement in T061 (US6 Phase 8)
  return [];
}

/**
 * Stub: marks notifications as read.
 * No-op until T061.
 */
export async function markAsRead(
  _ids: string[],
  _userId: string,
): Promise<void> {
  // TODO: implement in T061 (US6 Phase 8)
}
