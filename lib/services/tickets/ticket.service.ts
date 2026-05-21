import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";
import { logActivity, generateSummary } from "../logger.service";
import { sendTelegramNotification } from "../telegram/sender";
import { findOrCreateCustomer } from "./customer.service";
import { detectPriority } from "./auto-priority.service";
import { autoRespondWithTyping } from "../agent/agent.service";
import { sendEmailReply } from "../email/email.service";
import type {
  TicketStatus,
  TicketPriority,
  TicketCategory,
  TicketSource,
  TicketMessageAuthorType,
} from "@prisma/client";

// ─── SLA ─────────────────────────────────────────────────────────────────────

const SLA_HOURS: Record<TicketPriority, number> = {
  URGENT: 1,
  HIGH: 4,
  MEDIUM: 24,
  LOW: 72,
};

function calcSlaDeadline(priority: TicketPriority, createdAt: Date): Date {
  return new Date(createdAt.getTime() + SLA_HOURS[priority] * 60 * 60 * 1000);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type TicketSummary = {
  id: string;
  number: number;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  source: TicketSource;
  slaDeadline: Date | null;
  slaBreached: boolean;
  needsHumanHelp: boolean;
  creatorName: string;
  assignee: { id: string; login: string } | null;
  messagesCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TicketMessageView = {
  id: string;
  authorType: TicketMessageAuthorType;
  authorName: string;
  content: string;
  systemAction: string | null;
  createdAt: Date;
};

export type TicketCollaboratorView = {
  id: string;
  userId: string;
  login: string;
  role: string;
};

export type TicketFull = TicketSummary & {
  description: string;
  internalCreator: { id: string; login: string } | null;
  customer: { id: string; email: string; name: string | null } | null;
  resolvedBy: { id: string; login: string } | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  assignedAt: Date | null;
  messages: TicketMessageView[];
  collaborators: TicketCollaboratorView[];
};

type StatusCounters = {
  OPEN: number;
  IN_PROGRESS: number;
  WAITING_CUSTOMER: number;
  RESOLVED: number;
  CLOSED: number;
};

// ─── Include ─────────────────────────────────────────────────────────────────

const ticketInclude = {
  internalCreator: { select: { id: true, login: true } },
  customer: { select: { id: true, email: true, name: true } },
  assignee: { select: { id: true, login: true } },
  resolvedBy: { select: { id: true, login: true } },
  collaborators: {
    include: { user: { select: { id: true, login: true } } },
  },
  messages: {
    orderBy: { createdAt: "asc" as const },
    include: {
      managerAuthor: { select: { id: true, login: true } },
      customerAuthor: { select: { id: true, email: true, name: true } },
    },
  },
  _count: { select: { messages: true } },
} as const;

function mapTicketFull(t: {
  id: string;
  number: number;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  source: TicketSource;
  slaDeadline: Date | null;
  slaBreached: boolean;
  needsHumanHelp: boolean;
  internalCreator: { id: string; login: string } | null;
  customer: { id: string; email: string; name: string | null } | null;
  assignee: { id: string; login: string } | null;
  resolvedBy: { id: string; login: string } | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  assignedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { messages: number };
  messages: Array<{
    id: string;
    authorType: TicketMessageAuthorType;
    content: string;
    systemAction: string | null;
    createdAt: Date;
    managerAuthor: { id: string; login: string } | null;
    customerAuthor: { id: string; email: string; name: string | null } | null;
  }>;
  collaborators: Array<{
    id: string;
    userId: string;
    role: string;
    user: { id: string; login: string };
  }>;
}): TicketFull {
  const creatorName = t.internalCreator
    ? t.internalCreator.login
    : t.customer
      ? t.customer.name || t.customer.email
      : "—";

  return {
    id: t.id,
    number: t.number,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    category: t.category,
    source: t.source,
    slaDeadline: t.slaDeadline,
    slaBreached: t.slaBreached,
    needsHumanHelp: t.needsHumanHelp,
    creatorName,
    assignee: t.assignee,
    resolvedBy: t.resolvedBy,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
    assignedAt: t.assignedAt,
    internalCreator: t.internalCreator,
    customer: t.customer,
    messagesCount: t._count.messages,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    messages: t.messages.map((m) => ({
      id: m.id,
      authorType: m.authorType,
      authorName:
        m.authorType === "MANAGER"
          ? (m.managerAuthor?.login ?? "Менеджер")
          : m.authorType === "CUSTOMER"
            ? m.customerAuthor?.name || m.customerAuthor?.email || "Клиент"
            : m.authorType === "SYSTEM"
              ? "Система"
              : "Агент",
      content: m.content,
      systemAction: m.systemAction,
      createdAt: m.createdAt,
    })),
    collaborators: (t.collaborators ?? []).map((c) => ({
      id: c.id,
      userId: c.user.id,
      login: c.user.login,
      role: c.role,
    })),
  };
}

// ─── Collaborators ──────────────────────────────────────────────────────────

export async function addCollaborator(
  ticketId: string,
  targetUserId: string,
  role: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { workspaceId: true, number: true, title: true },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  const m = await checkMembership(ticket.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  // Verify target is workspace member
  const targetMembership = await checkMembership(
    ticket.workspaceId,
    targetUserId,
  );
  if (!targetMembership)
    throw new ApiError(
      "Пользователь не является участником workspace",
      "INVALID_USER",
      400,
    );

  await db.ticketCollaborator.upsert({
    where: { ticketId_userId: { ticketId, userId: targetUserId } },
    create: { ticketId, userId: targetUserId, role },
    update: { role },
  });

  // Telegram notification to collaborator
  void (async () => {
    try {
      const target = await db.user.findUnique({
        where: { id: targetUserId },
        select: { telegramChatId: true, tgNotifyTicketAssigned: true },
      });
      if (target?.telegramChatId && target.tgNotifyTicketAssigned) {
        const msg = [
          `<b>👥 Вас добавили к тикету</b>`,
          `<i>#${ticket.number} ${ticket.title}</i>`,
          `Роль: ${role === "reviewer" ? "Ревьюер" : role === "observer" ? "Наблюдатель" : "Исполнитель"}`,
        ].join("\n");
        void sendTelegramNotification(target.telegramChatId, msg);
      }
    } catch {
      /* fire-and-forget */
    }
  })();
}

export async function removeCollaborator(
  ticketId: string,
  targetUserId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { workspaceId: true },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  const m = await checkMembership(ticket.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  await db.ticketCollaborator.deleteMany({
    where: { ticketId, userId: targetUserId },
  });
}

// ─── createTicket ────────────────────────────────────────────────────────────

export async function createTicket(
  input: {
    workspaceId: string;
    title: string;
    description: string;
    source: TicketSource;
    category?: TicketCategory;
    priority?: TicketPriority;
    internalCreatorId?: string;
    customerId?: string;
    customerEmail?: string;
    customerName?: string;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TicketFull> {
  const m = await checkMembership(input.workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const priority = input.priority ?? "MEDIUM";
  const category = input.category ?? "GENERAL";
  const now = new Date();
  const slaDeadline = calcSlaDeadline(priority, now);

  // Resolve customer for EXTERNAL
  let customerId = input.customerId ?? null;
  if (input.source === "EXTERNAL" && !customerId && input.customerEmail) {
    const customer = await findOrCreateCustomer(
      input.workspaceId,
      { email: input.customerEmail, name: input.customerName },
      userId,
    );
    customerId = customer.id;
  }

  const messageAuthorType: TicketMessageAuthorType =
    input.source === "EXTERNAL" ? "CUSTOMER" : "MANAGER";

  // Retry loop for number uniqueness
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const ticket = await db.$transaction(async (tx) => {
        const last = await tx.ticket.findFirst({
          where: { workspaceId: input.workspaceId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const nextNumber = (last?.number ?? 0) + 1;

        const created = await tx.ticket.create({
          data: {
            workspaceId: input.workspaceId,
            number: nextNumber,
            title: input.title,
            description: input.description,
            source: input.source,
            category,
            priority,
            slaDeadline,
            internalCreatorId: input.source === "INTERNAL" ? userId : null,
            customerId,
            messages: {
              create: {
                authorType: messageAuthorType,
                managerAuthorId:
                  messageAuthorType === "MANAGER" ? userId : null,
                customerAuthorId:
                  messageAuthorType === "CUSTOMER" ? customerId : null,
                content: input.description,
              },
            },
          },
          include: ticketInclude,
        });

        return created;
      });

      void logActivity({
        workspaceId: input.workspaceId,
        actorId: userId,
        action: "TICKET_CREATED",
        entityType: "Ticket",
        entityId: ticket.id,
        summary: generateSummary("TICKET_CREATED", {
          kbArticleTitle: `#${ticket.number} ${ticket.title}`,
        }),
        metadata: {
          number: ticket.number,
          source: input.source,
          priority,
          category,
        },
      });

      return mapTicketFull(ticket);
    } catch (err: unknown) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === "P2002" && attempt < MAX_RETRIES - 1) continue;
      throw err;
    }
  }

  throw new ApiError("Не удалось создать тикет", "TICKET_CREATE_FAILED", 500);
}

// ─── updateTicket ────────────────────────────────────────────────────────────

export async function updateTicket(
  ticketId: string,
  data: {
    title?: string;
    category?: TicketCategory;
    priority?: TicketPriority;
  },
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TicketFull> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: {
      workspaceId: true,
      status: true,
      priority: true,
      createdAt: true,
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  if (ticket.status === "CLOSED") {
    throw new ApiError(
      "Нельзя редактировать закрытый тикет",
      "TICKET_CLOSED",
      400,
    );
  }

  const m2 = await checkMembership(ticket.workspaceId, userId);
  if (!m2 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  // Recalculate SLA from now when priority changes (not from createdAt,
  // otherwise old tickets switched to URGENT get an already-past deadline)
  const newSla =
    data.priority && data.priority !== ticket.priority
      ? calcSlaDeadline(data.priority, new Date())
      : undefined;

  const updated = await db.ticket.update({
    where: { id: ticketId },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}),
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(newSla !== undefined
        ? { slaDeadline: newSla, slaBreached: newSla < new Date() }
        : {}),
    },
    include: ticketInclude,
  });

  void logActivity({
    workspaceId: ticket.workspaceId,
    actorId: userId,
    action: "TICKET_UPDATED",
    entityType: "Ticket",
    entityId: ticketId,
    summary: generateSummary("TICKET_UPDATED", {
      kbArticleTitle: `#${updated.number} ${updated.title}`,
    }),
    metadata: data,
  });

  return mapTicketFull(updated);
}

// ─── changeTicketStatus ──────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "CLOSED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "RESOLVED", "CLOSED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: ["OPEN"],
};

export async function changeTicketStatus(
  ticketId: string,
  newStatus: TicketStatus,
  userId: string,
  userRole: "ADMIN" | "USER",
  note?: string,
): Promise<TicketFull> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: {
      workspaceId: true,
      status: true,
      number: true,
      title: true,
      assigneeId: true,
      internalCreatorId: true,
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  const m3 = await checkMembership(ticket.workspaceId, userId);
  if (!m3 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  if (!VALID_TRANSITIONS[ticket.status].includes(newStatus)) {
    throw new ApiError(
      `Нельзя перейти из ${ticket.status} в ${newStatus}`,
      "INVALID_STATUS_TRANSITION",
      400,
    );
  }

  const now = new Date();
  const statusData: Record<string, unknown> = { status: newStatus };
  if (newStatus === "RESOLVED") {
    statusData.resolvedAt = now;
    statusData.resolvedById = userId;
  }
  if (newStatus === "CLOSED") {
    statusData.closedAt = now;
  }
  // Reopening: clear resolution/close timestamps
  if (newStatus === "OPEN" && ticket.status === "CLOSED") {
    statusData.closedAt = null;
    statusData.resolvedAt = null;
    statusData.resolvedById = null;
  }

  const msgContent = note
    ? `Статус изменён: ${ticket.status} → ${newStatus}. ${note}`
    : `Статус изменён: ${ticket.status} → ${newStatus}`;

  await db.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticketId },
      data: statusData,
    });

    await tx.ticketMessage.create({
      data: {
        ticketId,
        authorType: "SYSTEM",
        content: msgContent,
        systemAction: "STATUS_CHANGED",
        metadata: JSON.stringify({
          from: ticket.status,
          to: newStatus,
        }),
      },
    });
  });

  void logActivity({
    workspaceId: ticket.workspaceId,
    actorId: userId,
    action: "TICKET_STATUS_CHANGED",
    entityType: "Ticket",
    entityId: ticketId,
    summary: generateSummary("TICKET_STATUS_CHANGED", {
      kbArticleTitle: `#${ticket.number} ${ticket.title}`,
      columnNameOld: ticket.status,
      columnName: newStatus,
    }),
    metadata: { from: ticket.status, to: newStatus },
  });

  // Telegram notification to assignee/creator about status change
  const notifyTargetId =
    ticket.assigneeId && ticket.assigneeId !== userId
      ? ticket.assigneeId
      : ticket.internalCreatorId && ticket.internalCreatorId !== userId
        ? ticket.internalCreatorId
        : null;

  if (notifyTargetId) {
    void (async () => {
      try {
        const recipient = await db.user.findUnique({
          where: { id: notifyTargetId },
          select: { telegramChatId: true, tgNotifyTicketMessage: true },
        });
        if (recipient?.telegramChatId && recipient.tgNotifyTicketMessage) {
          const actorUser = await db.user.findUnique({
            where: { id: userId },
            select: { login: true },
          });
          const statusLabel =
            newStatus === "CLOSED"
              ? "закрыл"
              : newStatus === "RESOLVED"
                ? "решил"
                : `изменил статус на ${newStatus}`;
          const msg = [
            `<b>🎫 Статус тикета изменён</b>`,
            `<b>${actorUser?.login ?? "Менеджер"}</b> ${statusLabel} тикет:`,
            `<i>#${ticket.number} ${ticket.title}</i>`,
          ].join("\n");
          void sendTelegramNotification(recipient.telegramChatId, msg);
        }
      } catch {
        /* fire-and-forget */
      }
    })();
  }

  const full = await db.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude,
  });

  return mapTicketFull(full!);
}

// ─── assignTicket ────────────────────────────────────────────────────────────

export async function assignTicket(
  ticketId: string,
  assigneeId: string | null,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TicketFull> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: {
      workspaceId: true,
      status: true,
      assigneeId: true,
      number: true,
      title: true,
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  if (ticket.status === "CLOSED") {
    throw new ApiError("Нельзя назначить закрытый тикет", "TICKET_CLOSED", 400);
  }

  const m4 = await checkMembership(ticket.workspaceId, userId);
  if (!m4 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  if (assigneeId) {
    const assigneeMembership = await checkMembership(
      ticket.workspaceId,
      assigneeId,
    );
    if (!assigneeMembership) {
      throw new ApiError(
        "Назначаемый не является участником workspace",
        "INVALID_ASSIGNEE",
        400,
      );
    }
  }

  let assigneeName = "—";
  if (assigneeId) {
    const u = await db.user.findUnique({
      where: { id: assigneeId },
      select: { login: true },
    });
    assigneeName = u?.login ?? "—";
  }

  const systemMsg = assigneeId
    ? `Назначен на ${assigneeName}`
    : "Снят с назначения";

  await db.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticketId },
      data: {
        assigneeId,
        assignedAt: assigneeId ? new Date() : null,
        ...(assigneeId && ticket.assigneeId === null && ticket.status === "OPEN"
          ? { status: "IN_PROGRESS" }
          : {}),
      },
    });

    await tx.ticketMessage.create({
      data: {
        ticketId,
        authorType: "SYSTEM",
        content: systemMsg,
        systemAction: "ASSIGNED",
      },
    });
  });

  void logActivity({
    workspaceId: ticket.workspaceId,
    actorId: userId,
    action: "TICKET_ASSIGNED",
    entityType: "Ticket",
    entityId: ticketId,
    summary: generateSummary("TICKET_ASSIGNED", {
      kbArticleTitle: `#${ticket.number} ${ticket.title}`,
      targetLogin: assigneeName,
    }),
    metadata: { assigneeId },
  });

  // Telegram notification to the new assignee
  if (assigneeId && assigneeId !== userId) {
    void (async () => {
      try {
        const assigneeUser = await db.user.findUnique({
          where: { id: assigneeId },
          select: { telegramChatId: true, tgNotifyTicketAssigned: true },
        });
        if (
          assigneeUser?.telegramChatId &&
          assigneeUser.tgNotifyTicketAssigned
        ) {
          const actorUser = await db.user.findUnique({
            where: { id: userId },
            select: { login: true },
          });
          const msg = [
            `<b>🎫 Назначен тикет</b>`,
            `<b>${actorUser?.login ?? "Менеджер"}</b> назначил вас на тикет:`,
            `<i>#${ticket.number} ${ticket.title}</i>`,
          ].join("\n");
          void sendTelegramNotification(assigneeUser.telegramChatId, msg);
        }
      } catch {
        /* fire-and-forget */
      }
    })();
  }

  // Re-fetch with new system message
  const full = await db.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude,
  });
  return mapTicketFull(full!);
}

// ─── addMessage ──────────────────────────────────────────────────────────────

export async function addMessage(
  ticketId: string,
  content: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TicketMessageView> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: {
      workspaceId: true,
      status: true,
      source: true,
      number: true,
      title: true,
      assigneeId: true,
      internalCreatorId: true,
      customerId: true,
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  if (ticket.status === "CLOSED") {
    throw new ApiError(
      "Нельзя добавить сообщение в закрытый тикет",
      "TICKET_CLOSED",
      400,
    );
  }

  const m5 = await checkMembership(ticket.workspaceId, userId);
  if (!m5 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const message = await db.$transaction(async (tx) => {
    const msg = await tx.ticketMessage.create({
      data: {
        ticketId,
        authorType: "MANAGER",
        managerAuthorId: userId,
        content,
      },
      include: {
        managerAuthor: { select: { id: true, login: true } },
      },
    });

    // Auto-transition from WAITING_CUSTOMER to IN_PROGRESS
    if (ticket.status === "WAITING_CUSTOMER") {
      await tx.ticket.update({
        where: { id: ticketId },
        data: { status: "IN_PROGRESS" },
      });
    }

    return msg;
  });

  void logActivity({
    workspaceId: ticket.workspaceId,
    actorId: userId,
    action: "TICKET_MESSAGE_ADDED",
    entityType: "TicketMessage",
    entityId: message.id,
    summary: generateSummary("TICKET_MESSAGE_ADDED", {
      kbArticleTitle: `#${ticket.number} ${ticket.title}`,
    }),
    metadata: {},
  });

  // Telegram notification to assignee (if someone else)
  const notifyUserId =
    ticket.assigneeId && ticket.assigneeId !== userId
      ? ticket.assigneeId
      : ticket.internalCreatorId && ticket.internalCreatorId !== userId
        ? ticket.internalCreatorId
        : null;

  if (notifyUserId) {
    void (async () => {
      try {
        const recipient = await db.user.findUnique({
          where: { id: notifyUserId },
          select: { telegramChatId: true, tgNotifyTicketMessage: true },
        });
        if (recipient?.telegramChatId && recipient.tgNotifyTicketMessage) {
          const short =
            content.length > 100 ? content.slice(0, 100) + "..." : content;
          const msg = [
            `<b>💬 Новое сообщение в тикете</b>`,
            `<i>#${ticket.number} ${ticket.title}</i>`,
            ``,
            `${message.managerAuthor?.login ?? "Менеджер"}: ${short}`,
          ].join("\n");
          void sendTelegramNotification(recipient.telegramChatId, msg);
        }
      } catch {
        /* fire-and-forget */
      }
    })();
  }

  // Email reply for EMAIL-source tickets
  if (ticket.source === "EMAIL" && ticket.customerId) {
    void (async () => {
      try {
        const cust = await db.customer.findUnique({
          where: { id: ticket.customerId! },
          select: { email: true },
        });
        if (cust && !cust.email.endsWith("@anonymous.local")) {
          void sendEmailReply(
            ticket.workspaceId,
            cust.email,
            `Re: #${ticket.number} ${ticket.title}`,
            content,
          );
        }
      } catch {
        /* fire-and-forget */
      }
    })();
  }

  return {
    id: message.id,
    authorType: "MANAGER",
    authorName: message.managerAuthor?.login ?? "Менеджер",
    content: message.content,
    systemAction: null,
    createdAt: message.createdAt,
  };
}

// ─── getTicketById ───────────────────────────────────────────────────────────

export async function getTicketById(
  ticketId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TicketFull> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude,
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  const m6 = await checkMembership(ticket.workspaceId, userId);
  if (!m6 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  return mapTicketFull(ticket);
}

// ─── deleteTicket ────────────────────────────────────────────────────────────

export async function deleteTicket(
  ticketId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<void> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { workspaceId: true, number: true, title: true },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);

  // Only ADMIN can delete
  if (userRole !== "ADMIN") {
    throw new ApiError(
      "Только администратор может удалять тикеты",
      "FORBIDDEN",
      403,
    );
  }

  await db.ticket.delete({ where: { id: ticketId } });

  void logActivity({
    workspaceId: ticket.workspaceId,
    actorId: userId,
    action: "TICKET_DELETED",
    entityType: "Ticket",
    entityId: ticketId,
    summary: generateSummary("TICKET_DELETED", {
      kbArticleTitle: `#${ticket.number} ${ticket.title}`,
    }),
    metadata: {},
  });
}

// ─── listTickets ─────────────────────────────────────────────────────────────

export async function listTickets(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
  filters: {
    page?: number;
    pageSize?: number;
    status?: TicketStatus[];
    priority?: TicketPriority[];
    category?: TicketCategory[];
    source?: TicketSource[];
    assigneeIds?: string[];
    search?: string;
    slaBreached?: boolean;
    sortBy?: "createdAt" | "updatedAt" | "priority" | "slaDeadline";
    sortOrder?: "asc" | "desc";
  } = {},
): Promise<{
  data: TicketSummary[];
  total: number;
  counters: StatusCounters;
}> {
  const m7 = await checkMembership(workspaceId, userId);
  if (!m7 && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const skip = (page - 1) * pageSize;
  const sortBy = filters.sortBy ?? "updatedAt";
  const sortOrder = filters.sortOrder ?? "desc";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { workspaceId };

  if (filters.status?.length) where.status = { in: filters.status };
  if (filters.priority?.length) where.priority = { in: filters.priority };
  if (filters.category?.length) where.category = { in: filters.category };
  if (filters.source?.length) where.source = { in: filters.source };
  if (filters.assigneeIds?.length)
    where.assigneeId = { in: filters.assigneeIds };
  if (filters.slaBreached !== undefined)
    where.slaBreached = filters.slaBreached;
  if (filters.search) {
    where.OR = [
      { title: { contains: filters.search } },
      { description: { contains: filters.search } },
    ];
  }

  const [tickets, total] = await db.$transaction([
    db.ticket.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { [sortBy]: sortOrder },
      include: {
        internalCreator: { select: { id: true, login: true } },
        customer: { select: { id: true, email: true, name: true } },
        assignee: { select: { id: true, login: true } },
        _count: { select: { messages: true } },
      },
    }),
    db.ticket.count({ where }),
  ]);

  // Status counters (for the whole workspace, not filtered)
  const counterRows = await db.ticket.groupBy({
    by: ["status"],
    where: { workspaceId },
    _count: true,
  });
  const counters: StatusCounters = {
    OPEN: 0,
    IN_PROGRESS: 0,
    WAITING_CUSTOMER: 0,
    RESOLVED: 0,
    CLOSED: 0,
  };
  for (const r of counterRows) {
    counters[r.status] = r._count;
  }

  return {
    data: tickets.map((t) => {
      const creatorName = t.internalCreator
        ? t.internalCreator.login
        : t.customer
          ? t.customer.name || t.customer.email
          : "—";
      return {
        id: t.id,
        number: t.number,
        title: t.title,
        status: t.status,
        priority: t.priority,
        category: t.category,
        source: t.source,
        slaDeadline: t.slaDeadline,
        slaBreached: t.slaBreached,
        needsHumanHelp: t.needsHumanHelp,
        creatorName,
        assignee: t.assignee,
        messagesCount: t._count.messages,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    }),
    total,
    counters,
  };
}

// ─── Public chat: create ticket as customer ─────────────────────────────────

export async function createTicketAsCustomer(
  workspaceId: string,
  customerId: string,
  input: { title: string; description: string; category: TicketCategory },
): Promise<TicketFull> {
  // Приоритет определяется автоматически по тексту обращения
  const priority: TicketPriority = detectPriority(
    `${input.title} ${input.description}`,
  );
  const category = input.category;
  const now = new Date();
  const slaDeadline = calcSlaDeadline(priority, now);

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const ticket = await db.$transaction(async (tx) => {
        const last = await tx.ticket.findFirst({
          where: { workspaceId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const nextNumber = (last?.number ?? 0) + 1;

        return tx.ticket.create({
          data: {
            workspaceId,
            number: nextNumber,
            title: input.title,
            description: input.description,
            source: "EXTERNAL",
            category,
            priority,
            slaDeadline,
            customerId,
            messages: {
              create: {
                authorType: "CUSTOMER",
                customerAuthorId: customerId,
                content: input.description,
              },
            },
          },
          include: ticketInclude,
        });
      });

      void logActivity({
        workspaceId,
        actorId: null,
        action: "TICKET_CREATED",
        entityType: "Ticket",
        entityId: ticket.id,
        summary: generateSummary("TICKET_CREATED", {
          kbArticleTitle: `#${ticket.number} ${ticket.title}`,
        }),
        metadata: {
          number: ticket.number,
          source: "EXTERNAL",
          priority,
          category,
        },
      });

      const createdTicket = mapTicketFull(ticket);

      // Trigger autopilot AFTER returning (fire-and-forget, with typing indicator)
      void (async () => {
        try {
          await autoRespondWithTyping(ticket.id, workspaceId);
        } catch (agentErr) {
          console.error("[Autopilot error]", agentErr);
        }
      })();

      return createdTicket;
    } catch (err: unknown) {
      const prismaErr = err as { code?: string };
      if (prismaErr.code === "P2002" && attempt < MAX_RETRIES - 1) continue;
      throw err;
    }
  }

  throw new ApiError("Не удалось создать тикет", "TICKET_CREATE_FAILED", 500);
}

// ─── Public chat: add message as customer ───────────────────────────────────

export async function addMessageAsCustomer(
  ticketId: string,
  customerId: string,
  content: string,
): Promise<TicketMessageView> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: {
      workspaceId: true,
      status: true,
      customerId: true,
      number: true,
      title: true,
      assigneeId: true,
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);
  if (ticket.customerId !== customerId) {
    throw new ApiError("Нет доступа к тикету", "FORBIDDEN", 403);
  }
  if (ticket.status === "CLOSED") {
    throw new ApiError(
      "Нельзя добавить сообщение в закрытый тикет",
      "TICKET_CLOSED",
      400,
    );
  }

  const message = await db.$transaction(async (tx) => {
    const msg = await tx.ticketMessage.create({
      data: {
        ticketId,
        authorType: "CUSTOMER",
        customerAuthorId: customerId,
        content,
      },
      include: {
        customerAuthor: { select: { id: true, email: true, name: true } },
      },
    });

    // Auto-transition from WAITING_CUSTOMER to IN_PROGRESS
    if (ticket.status === "WAITING_CUSTOMER") {
      await tx.ticket.update({
        where: { id: ticketId },
        data: { status: "IN_PROGRESS" },
      });
    }

    return msg;
  });

  void logActivity({
    workspaceId: ticket.workspaceId,
    actorId: null,
    action: "TICKET_MESSAGE_ADDED",
    entityType: "TicketMessage",
    entityId: message.id,
    summary: generateSummary("TICKET_MESSAGE_ADDED", {
      kbArticleTitle: `#${ticket.number} ${ticket.title}`,
    }),
    metadata: {},
  });

  // Telegram notification to assignee
  if (ticket.assigneeId) {
    void (async () => {
      try {
        const recipient = await db.user.findUnique({
          where: { id: ticket.assigneeId! },
          select: { telegramChatId: true, tgNotifyTicketMessage: true },
        });
        if (recipient?.telegramChatId && recipient.tgNotifyTicketMessage) {
          const short =
            content.length > 100 ? content.slice(0, 100) + "..." : content;
          const authorName =
            message.customerAuthor?.name ||
            message.customerAuthor?.email ||
            "Клиент";
          const msg = [
            `<b>💬 Новое сообщение от клиента</b>`,
            `<i>#${ticket.number} ${ticket.title}</i>`,
            ``,
            `${authorName}: ${short}`,
          ].join("\n");
          void sendTelegramNotification(recipient.telegramChatId, msg);
        }
      } catch {
        /* fire-and-forget */
      }
    })();
  }

  // Trigger autopilot (with typing indicator)
  void (async () => {
    try {
      const { autoRespondWithTyping } = await import("../agent/agent.service");
      await autoRespondWithTyping(ticketId, ticket.workspaceId);
    } catch (agentErr) {
      console.error("[Autopilot error]", agentErr);
    }
  })();

  return {
    id: message.id,
    authorType: "CUSTOMER",
    authorName:
      message.customerAuthor?.name || message.customerAuthor?.email || "Клиент",
    content: message.content,
    systemAction: null,
    createdAt: message.createdAt,
  };
}

// ─── Public chat: list customer tickets ─────────────────────────────────────

export async function listCustomerTickets(
  workspaceId: string,
  customerId: string,
): Promise<
  Array<{
    id: string;
    number: number;
    title: string;
    status: TicketStatus;
    lastMessageAt: Date;
    messagesCount: number;
  }>
> {
  const tickets = await db.ticket.findMany({
    where: { workspaceId, customerId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return tickets.map((t) => ({
    id: t.id,
    number: t.number,
    title: t.title,
    status: t.status,
    lastMessageAt: t.updatedAt,
    messagesCount: t._count.messages,
  }));
}

// ─── Public chat: get ticket for customer ───────────────────────────────────

export async function getTicketForCustomer(
  ticketId: string,
  customerId: string,
): Promise<TicketFull> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude,
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);
  if (ticket.customerId !== customerId) {
    throw new ApiError("Нет доступа к тикету", "FORBIDDEN", 403);
  }
  const full = mapTicketFull(ticket);
  // Hide internal messages from customer view
  full.messages = full.messages.filter(
    (m) => m.systemAction !== "AGENT_SUMMARY",
  );
  return full;
}
