import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { logActivity, generateSummary } from "../logger.service";

export type TicketRatingView = {
  id: string;
  ticketId: string;
  score: number;
  comment: string | null;
  createdAt: Date;
};

/**
 * Клиент ставит оценку закрытому/решённому тикету.
 * Без auth менеджера — вызывается из публичного чата.
 */
export async function rateTicket(
  ticketId: string,
  customerId: string,
  score: number,
  comment?: string,
  minCreatedAt?: Date,
): Promise<TicketRatingView> {
  if (score < 1 || score > 5) {
    throw new ApiError("Оценка должна быть от 1 до 5", "INVALID_SCORE", 400);
  }

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: {
      workspaceId: true,
      customerId: true,
      status: true,
      number: true,
      title: true,
      createdAt: true,
    },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);
  if (ticket.customerId !== customerId) {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }
  // Unverified email session cannot rate the customer's prior tickets.
  if (minCreatedAt && ticket.createdAt < minCreatedAt) {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }
  if (ticket.status !== "CLOSED" && ticket.status !== "RESOLVED") {
    throw new ApiError(
      "Оценить можно только закрытый тикет",
      "TICKET_NOT_CLOSED",
      400,
    );
  }

  // Проверяем что ещё не оценён
  const existing = await db.ticketRating.findUnique({
    where: { ticketId },
  });
  if (existing) {
    throw new ApiError("Тикет уже оценён", "ALREADY_RATED", 409);
  }

  const rating = await db.ticketRating.create({
    data: {
      ticketId,
      customerId,
      score,
      comment: comment ?? null,
    },
  });

  void logActivity({
    workspaceId: ticket.workspaceId,
    actorId: null,
    action: "TICKET_RATED",
    entityType: "TicketRating",
    entityId: rating.id,
    summary: generateSummary("TICKET_RATED", {
      kbArticleTitle: `#${ticket.number} ${ticket.title}`,
    }),
    metadata: { score, ticketNumber: ticket.number },
  });

  return rating;
}

/**
 * Получить оценку тикета (для отображения клиенту-владельцу).
 * IDOR-fix: требуется customerId владельца тикета; чужой рейтинг → 403.
 */
export async function getTicketRating(
  ticketId: string,
  customerId: string,
  minCreatedAt?: Date,
): Promise<TicketRatingView | null> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { customerId: true, createdAt: true },
  });
  if (!ticket) throw new ApiError("Тикет не найден", "NOT_FOUND", 404);
  if (ticket.customerId !== customerId) {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }
  // Unverified email session cannot read ratings of the customer's prior tickets.
  if (minCreatedAt && ticket.createdAt < minCreatedAt) {
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);
  }
  return db.ticketRating.findUnique({ where: { ticketId } });
}
