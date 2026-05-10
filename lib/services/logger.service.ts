import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "./workspace.service";
import { sendTelegramNotification } from "./telegram/sender";
import type { ActivityAction, LogLevel, Prisma } from "@prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActivityLogItem = {
  id: string;
  action: ActivityAction;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  taskId: string | null;
  columnId: string | null;
  actor: { id: string; login: string } | null;
  createdAt: Date;
};

export type SystemLogItem = {
  id: string;
  level: LogLevel;
  source: string;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  durationMs: number | null;
  message: string;
  errorStack: string | null;
  metadata: Record<string, unknown> | null;
  workspaceId: string | null;
  userId: string | null;
  createdAt: Date;
};

export type ActivityLogFilters = {
  page?: number;
  pageSize?: number;
  from?: Date;
  to?: Date;
  actions?: ActivityAction[];
  actorIds?: string[];
  taskId?: string;
  search?: string;
};

export type SystemLogFilters = {
  page?: number;
  pageSize?: number;
  from?: Date;
  to?: Date;
  level?: LogLevel;
  source?: string;
};

// ─── SummaryContext ───────────────────────────────────────────────────────────

export type SummaryContext = {
  actorLogin?: string | null;
  taskTitle?: string | null;
  taskTitleOld?: string | null;
  columnName?: string | null;
  columnNameOld?: string | null;
  targetLogin?: string | null;
  workspaceName?: string | null;
  moduleName?: string | null;
  priority?: string | null;
  priorityOld?: string | null;
  role?: string | null;
  attachmentName?: string | null;
  checklistText?: string | null;
  labelName?: string | null;
  // KB
  kbArticleTitle?: string | null;
  kbCategoryName?: string | null;
  kbTagName?: string | null;
  sourceUrl?: string | null;
};

// ─── generateSummary ──────────────────────────────────────────────────────────

export function generateSummary(
  action: ActivityAction,
  ctx: SummaryContext,
): string {
  const actor = ctx.actorLogin ?? "Система";
  const task = ctx.taskTitle ? `«${ctx.taskTitle}»` : "задачу";
  const col = ctx.columnName ? `«${ctx.columnName}»` : "колонку";
  const target = ctx.targetLogin ?? "пользователя";

  switch (action) {
    // Task
    case "TASK_CREATED":
      return `${actor} создал задачу ${task}`;
    case "TASK_DELETED":
      return `${actor} удалил задачу ${task}`;
    case "TASK_MOVED":
      return `${actor} переместил задачу ${task} из «${ctx.columnNameOld ?? "?"}» в ${col}`;
    case "TASK_UPDATED":
      if (ctx.taskTitleOld) {
        return `${actor} переименовал задачу «${ctx.taskTitleOld}» → ${task}`;
      }
      return `${actor} обновил задачу ${task}`;
    case "TASK_PRIORITY_CHANGED":
      return `${actor} изменил приоритет задачи ${task}: ${ctx.priorityOld ?? "?"} → ${ctx.priority ?? "?"}`;
    case "TASK_DATE_CHANGED":
      return `${actor} изменил даты задачи ${task}`;
    case "TASK_ASSIGNEE_ADDED":
      return `${actor} назначил ${target} на задачу ${task}`;
    case "TASK_ASSIGNEE_REMOVED":
      return `${actor} снял ${target} с задачи ${task}`;
    case "TASK_LABEL_ADDED":
      return `${actor} добавил метку «${ctx.labelName ?? "?"}» к задаче ${task}`;
    case "TASK_LABEL_REMOVED":
      return `${actor} удалил метку «${ctx.labelName ?? "?"}» с задачи ${task}`;
    case "TASK_CHECKLIST_ITEM_ADDED":
      return `${actor} добавил пункт в чек-лист задачи ${task}`;
    case "TASK_CHECKLIST_ITEM_TOGGLED":
      return `${actor} отметил пункт чек-листа в задаче ${task}`;
    case "TASK_CHECKLIST_ITEM_REMOVED":
      return `${actor} удалил пункт чек-листа из задачи ${task}`;

    // Comment & Attachment
    case "COMMENT_CREATED":
      return `${actor} добавил комментарий к задаче ${task}`;
    case "COMMENT_UPDATED":
      return `${actor} отредактировал комментарий в задаче ${task}`;
    case "COMMENT_DELETED":
      return `${actor} удалил комментарий в задаче ${task}`;
    case "ATTACHMENT_UPLOADED":
      return `${actor} прикрепил файл «${ctx.attachmentName ?? "?"}» к задаче ${task}`;
    case "ATTACHMENT_DELETED":
      return `${actor} удалил файл «${ctx.attachmentName ?? "?"}» с задачи ${task}`;

    // Column
    case "COLUMN_CREATED":
      return `${actor} создал колонку ${col}`;
    case "COLUMN_RENAMED":
      return `${actor} переименовал колонку «${ctx.columnNameOld ?? "?"}» → ${col}`;
    case "COLUMN_DELETED":
      return `${actor} удалил колонку ${col}`;
    case "COLUMN_REORDERED":
      return `${actor} изменил порядок колонок`;

    // Workspace
    case "WORKSPACE_CREATED":
      return `${actor} создал workspace «${ctx.workspaceName ?? "?"}»`;
    case "WORKSPACE_UPDATED":
      return `${actor} обновил настройки workspace`;
    case "WORKSPACE_DELETED":
      return `${actor} удалил workspace «${ctx.workspaceName ?? "?"}»`;
    case "MEMBER_ADDED":
      return `${actor} добавил ${target} в workspace`;
    case "MEMBER_REMOVED":
      return `${actor} удалил ${target} из workspace`;
    case "MEMBER_ROLE_CHANGED":
      return `${actor} изменил роль ${target} на ${ctx.role ?? "?"}`;
    case "MODULE_ENABLED":
      return `${actor} включил модуль «${ctx.moduleName ?? "?"}»`;
    case "MODULE_DISABLED":
      return `${actor} отключил модуль «${ctx.moduleName ?? "?"}»`;

    // System
    case "USER_LOGIN":
      return `${actor} вошёл в систему`;
    case "USER_LOGOUT":
      return `${actor} вышел из системы`;
    case "USER_CREATED_BY_ADMIN":
      return `${actor} создал пользователя ${target}`;
    case "USER_DEACTIVATED":
      return `${actor} деактивировал пользователя ${target}`;
    case "USER_ACTIVATED":
      return `${actor} активировал пользователя ${target}`;
    case "USER_PASSWORD_RESET":
      return `${actor} сбросил пароль пользователя ${target}`;
    case "USER_ROLE_CHANGED":
      return `${actor} изменил роль пользователя ${target} на ${ctx.role ?? "?"}`;

    // Knowledge Base
    case "KB_ARTICLE_CREATED":
      return `${actor} создал статью «${ctx.kbArticleTitle ?? "?"}»`;
    case "KB_ARTICLE_UPDATED":
      return `${actor} обновил статью «${ctx.kbArticleTitle ?? "?"}»`;
    case "KB_ARTICLE_DELETED":
      return `${actor} удалил статью «${ctx.kbArticleTitle ?? "?"}»`;
    case "KB_ARTICLE_VERSION_RESTORED":
      return `${actor} восстановил версию статьи «${ctx.kbArticleTitle ?? "?"}»`;
    case "KB_CATEGORY_CREATED":
      return `${actor} создал категорию «${ctx.kbCategoryName ?? "?"}»`;
    case "KB_CATEGORY_UPDATED":
      return `${actor} обновил категорию «${ctx.kbCategoryName ?? "?"}»`;
    case "KB_CATEGORY_DELETED":
      return `${actor} удалил категорию «${ctx.kbCategoryName ?? "?"}»`;
    case "KB_TAG_CREATED":
      return `${actor} создал тег «${ctx.kbTagName ?? "?"}»`;
    case "KB_TAG_DELETED":
      return `${actor} удалил тег «${ctx.kbTagName ?? "?"}»`;
    case "KB_ARTICLE_IMPORTED_FROM_FILE":
      return `${actor} импортировал статью «${ctx.kbArticleTitle ?? "?"}» из файла`;
    case "KB_ARTICLE_IMPORTED_FROM_URL":
      return `${actor} импортировал статью «${ctx.kbArticleTitle ?? "?"}» с ${ctx.sourceUrl ?? "URL"}`;
    case "KB_FILE_UPLOADED":
      return `${actor} загрузил файл «${ctx.attachmentName ?? "?"}» в базу знаний`;
    case "KB_FILE_DELETED":
      return `${actor} удалил файл «${ctx.attachmentName ?? "?"}» из базы знаний`;

    default:
      return `${actor} выполнил действие`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeStringify(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, (_key, value: unknown) => {
      if (typeof value === "symbol" || typeof value === "function") {
        return String(value);
      }
      return value;
    });
  } catch {
    return "{}";
  }
}

function safeParse(str: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(str);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

// ─── logActivity ──────────────────────────────────────────────────────────────

export async function logActivity(input: {
  workspaceId?: string;
  actorId?: string | null;
  action: ActivityAction;
  entityType?: string;
  entityId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
  taskId?: string;
  columnId?: string;
  tx?: Prisma.TransactionClient;
}): Promise<void> {
  try {
    const client = input.tx ?? db;
    await client.activityLog.create({
      data: {
        workspaceId: input.workspaceId ?? null,
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        summary: input.summary,
        metadata: safeStringify(input.metadata ?? {}),
        taskId: input.taskId ?? null,
        columnId: input.columnId ?? null,
      },
    });
  } catch (err) {
    console.error("[logActivity] Failed to write activity log:", err);
  }
}

// ─── logSystem ────────────────────────────────────────────────────────────────

export async function logSystem(input: {
  level?: LogLevel;
  source: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  message: string;
  errorStack?: string;
  metadata?: Record<string, unknown>;
  workspaceId?: string;
  userId?: string;
}): Promise<void> {
  try {
    await db.systemLog.create({
      data: {
        level: input.level ?? "INFO",
        source: input.source,
        method: input.method ?? null,
        path: input.path ?? null,
        statusCode: input.statusCode ?? null,
        durationMs: input.durationMs ?? null,
        message: input.message,
        errorStack: input.errorStack ?? null,
        metadata: input.metadata ? safeStringify(input.metadata) : null,
        workspaceId: input.workspaceId ?? null,
        userId: input.userId ?? null,
      },
    });
  } catch (err) {
    console.error("[logSystem] Failed to write system log:", err);
  }
}

// ─── getActivityLogs ──────────────────────────────────────────────────────────

export async function getActivityLogs(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  filters: ActivityLogFilters = {},
): Promise<{ data: ActivityLogItem[]; total: number }> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const skip = (page - 1) * pageSize;

  const where: Prisma.ActivityLogWhereInput = {
    workspaceId,
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
    ...(filters.actions?.length ? { action: { in: filters.actions } } : {}),
    ...(filters.actorIds?.length ? { actorId: { in: filters.actorIds } } : {}),
    ...(filters.taskId ? { taskId: filters.taskId } : {}),
    ...(filters.search ? { summary: { contains: filters.search } } : {}),
  };

  const [logs, total] = await db.$transaction([
    db.activityLog.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        actor: { select: { id: true, login: true } },
      },
    }),
    db.activityLog.count({ where }),
  ]);

  return {
    data: logs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      summary: log.summary,
      metadata: safeParse(log.metadata),
      taskId: log.taskId,
      columnId: log.columnId,
      actor: log.actor ?? null,
      createdAt: log.createdAt,
    })),
    total,
  };
}

// ─── getSystemLogs ────────────────────────────────────────────────────────────

export async function getSystemLogs(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  filters: SystemLogFilters = {},
): Promise<{ data: SystemLogItem[]; total: number }> {
  const membership = await checkMembership(workspaceId, userId);
  if (!membership && userRole !== "ADMIN") {
    throw new ApiError("Нет доступа к workspace", "FORBIDDEN", 403);
  }

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const skip = (page - 1) * pageSize;

  const where: Prisma.SystemLogWhereInput = {
    workspaceId,
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
    ...(filters.level ? { level: filters.level } : {}),
    ...(filters.source ? { source: { contains: filters.source } } : {}),
  };

  const [logs, total] = await db.$transaction([
    db.systemLog.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
    }),
    db.systemLog.count({ where }),
  ]);

  return {
    data: logs.map((log) => ({
      id: log.id,
      level: log.level,
      source: log.source,
      method: log.method,
      path: log.path,
      statusCode: log.statusCode,
      durationMs: log.durationMs,
      message: log.message,
      errorStack: log.errorStack,
      metadata: log.metadata ? safeParse(log.metadata) : null,
      workspaceId: log.workspaceId,
      userId: log.userId,
      createdAt: log.createdAt,
    })),
    total,
  };
}

// ─── cleanupOldLogs ───────────────────────────────────────────────────────────

export async function cleanupOldLogs(): Promise<{
  activityDeleted: number;
  systemDeleted: number;
}> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [activityResult, systemResult] = await Promise.all([
    db.activityLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    db.systemLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);

  return {
    activityDeleted: activityResult.count,
    systemDeleted: systemResult.count,
  };
}

// ─── notifyCriticalEvent ──────────────────────────────────────────────────────

// Critical events that trigger Telegram notifications for specific recipients.
// Called internally after logActivity for the relevant actions.

type CriticalEventInput =
  | {
      action: "TASK_DELETED";
      workspaceId: string;
      workspaceName: string;
      taskTitle: string;
      actorLogin: string;
    }
  | {
      action: "MEMBER_REMOVED";
      removedUserId: string;
      workspaceName: string;
      actorLogin: string;
    }
  | {
      action: "WORKSPACE_DELETED";
      memberIds: string[];
      workspaceName: string;
      actorLogin: string;
    }
  | {
      action: "MEMBER_ROLE_CHANGED";
      targetUserId: string;
      workspaceName: string;
      newRole: string;
      actorLogin: string;
    };

export async function notifyCriticalEvent(
  input: CriticalEventInput,
): Promise<void> {
  try {
    if (input.action === "TASK_DELETED") {
      const members = await db.workspaceMember.findMany({
        where: { workspaceId: input.workspaceId },
        select: {
          user: {
            select: {
              telegramChatId: true,
              tgNotifyTaskDeleted: true,
            },
          },
        },
      });

      const msg = `⚠️ В workspace «${input.workspaceName}» удалена задача «${input.taskTitle}» пользователем ${input.actorLogin}`;

      for (const { user } of members) {
        if (user.telegramChatId && user.tgNotifyTaskDeleted) {
          void sendTelegramNotification(user.telegramChatId, msg);
        }
      }
    } else if (input.action === "MEMBER_REMOVED") {
      const user = await db.user.findUnique({
        where: { id: input.removedUserId },
        select: { telegramChatId: true, tgNotifyMemberRemoved: true },
      });

      if (user?.telegramChatId && user.tgNotifyMemberRemoved) {
        const msg = `⚠️ Вас удалили из workspace «${input.workspaceName}»`;
        void sendTelegramNotification(user.telegramChatId, msg);
      }
    } else if (input.action === "WORKSPACE_DELETED") {
      if (input.memberIds.length === 0) return;

      const users = await db.user.findMany({
        where: { id: { in: input.memberIds } },
        select: { telegramChatId: true, tgNotifyWorkspaceDeleted: true },
      });

      const msg = `⚠️ Workspace «${input.workspaceName}» был удалён`;

      for (const user of users) {
        if (user.telegramChatId && user.tgNotifyWorkspaceDeleted) {
          void sendTelegramNotification(user.telegramChatId, msg);
        }
      }
    } else if (input.action === "MEMBER_ROLE_CHANGED") {
      const user = await db.user.findUnique({
        where: { id: input.targetUserId },
        select: { telegramChatId: true, tgNotifyRoleChanged: true },
      });

      if (user?.telegramChatId && user.tgNotifyRoleChanged) {
        const msg = `⚠️ Ваша роль в workspace «${input.workspaceName}» изменена на ${input.newRole}`;
        void sendTelegramNotification(user.telegramChatId, msg);
      }
    }
  } catch (err) {
    console.error("[notifyCriticalEvent] Failed:", err);
  }
}
