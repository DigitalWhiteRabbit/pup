import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import { checkMembership } from "../workspace.service";

export type TicketAnalytics = {
  total: number;
  open: number;
  closed: number;
  resolved: number;
  // Закрыты ИИ vs менеджерами
  closedByAgent: number;
  closedByManager: number;
  agentPercent: number;
  // Среднее время первого ответа (мс)
  avgFirstResponseMs: number | null;
  avgFirstResponseFormatted: string;
  // Топ категорий
  topCategories: Array<{ category: string; count: number; percent: number }>;
  // По статусам
  byStatus: Array<{ status: string; count: number }>;
  // По приоритетам
  byPriority: Array<{ priority: string; count: number }>;
  // По источникам
  bySource: Array<{ source: string; count: number }>;
  // SLA
  slaBreachedCount: number;
  slaBreachedPercent: number;
  // CSAT
  csatAverage: number | null;
  csatCount: number;
  csatDistribution: Array<{ score: number; count: number }>;
};

const CATEGORY_LABELS: Record<string, string> = {
  FINANCIAL: "Финансы",
  TECHNICAL: "Техническое",
  GENERAL: "Общее",
  BUG: "Баг",
  FEATURE_REQUEST: "Фича",
};

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} сек`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} мин`;
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`;
}

export async function getTicketAnalytics(
  workspaceId: string,
  userId: string,
  userRole: "ADMIN" | "USER",
): Promise<TicketAnalytics> {
  const m = await checkMembership(workspaceId, userId);
  if (!m && userRole !== "ADMIN")
    throw new ApiError("Нет доступа", "FORBIDDEN", 403);

  // Все тикеты workspace
  const tickets = await db.ticket.findMany({
    where: { workspaceId },
    select: {
      id: true,
      status: true,
      priority: true,
      category: true,
      source: true,
      slaBreached: true,
      createdAt: true,
      resolvedById: true,
      messages: {
        orderBy: { createdAt: "asc" },
        take: 2,
        select: {
          authorType: true,
          createdAt: true,
        },
      },
    },
  });

  const total = tickets.length;
  const open = tickets.filter(
    (t) =>
      t.status === "OPEN" ||
      t.status === "IN_PROGRESS" ||
      t.status === "WAITING_CUSTOMER",
  ).length;
  const closed = tickets.filter((t) => t.status === "CLOSED").length;
  const resolved = tickets.filter((t) => t.status === "RESOLVED").length;

  // Закрыты ИИ (AGENT messages) vs менеджерами
  // Считаем: если последний не-SYSTEM message перед закрытием был от AGENT — закрыт ИИ
  // Пока ИИ нет, все закрыты менеджерами. Используем resolvedById: null = agent
  const closedOrResolved = tickets.filter(
    (t) => t.status === "CLOSED" || t.status === "RESOLVED",
  );
  const closedByAgent = closedOrResolved.filter((t) => !t.resolvedById).length;
  const closedByManager = closedOrResolved.length - closedByAgent;
  const agentPercent =
    closedOrResolved.length > 0
      ? Math.round((closedByAgent / closedOrResolved.length) * 100)
      : 0;

  // Среднее время первого ответа менеджера
  const responseTimes: number[] = [];
  for (const t of tickets) {
    if (t.messages.length < 2) continue;
    const first = t.messages[0];
    const second = t.messages[1];
    if (!first || !second) continue;
    // Если первое сообщение от клиента, а второе от менеджера/агента
    if (
      first.authorType === "CUSTOMER" &&
      (second.authorType === "MANAGER" || second.authorType === "AGENT")
    ) {
      const diff =
        new Date(second.createdAt).getTime() -
        new Date(first.createdAt).getTime();
      if (diff > 0) responseTimes.push(diff);
    }
  }
  const avgFirstResponseMs =
    responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : null;

  // Топ категорий
  const catMap = new Map<string, number>();
  for (const t of tickets) {
    catMap.set(t.category, (catMap.get(t.category) ?? 0) + 1);
  }
  const topCategories = Array.from(catMap.entries())
    .map(([category, count]) => ({
      category: CATEGORY_LABELS[category] ?? category,
      count,
      percent: total > 0 ? Math.round((count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // По статусам
  const statusMap = new Map<string, number>();
  for (const t of tickets) {
    statusMap.set(t.status, (statusMap.get(t.status) ?? 0) + 1);
  }
  const byStatus = Array.from(statusMap.entries()).map(([status, count]) => ({
    status,
    count,
  }));

  // По приоритетам
  const prioMap = new Map<string, number>();
  for (const t of tickets) {
    prioMap.set(t.priority, (prioMap.get(t.priority) ?? 0) + 1);
  }
  const byPriority = Array.from(prioMap.entries()).map(([priority, count]) => ({
    priority,
    count,
  }));

  // По источникам
  const srcMap = new Map<string, number>();
  for (const t of tickets) {
    srcMap.set(t.source, (srcMap.get(t.source) ?? 0) + 1);
  }
  const bySource = Array.from(srcMap.entries()).map(([source, count]) => ({
    source,
    count,
  }));

  // SLA
  const slaBreachedCount = tickets.filter((t) => t.slaBreached).length;
  const slaBreachedPercent =
    total > 0 ? Math.round((slaBreachedCount / total) * 100) : 0;

  // CSAT
  const ratings = await db.ticketRating.findMany({
    where: {
      ticket: { workspaceId },
    },
    select: { score: true },
  });
  const csatCount = ratings.length;
  const csatAverage =
    csatCount > 0
      ? Math.round(
          (ratings.reduce((sum, r) => sum + r.score, 0) / csatCount) * 10,
        ) / 10
      : null;
  const csatDist = new Map<number, number>();
  for (const r of ratings) {
    csatDist.set(r.score, (csatDist.get(r.score) ?? 0) + 1);
  }
  const csatDistribution = [1, 2, 3, 4, 5].map((score) => ({
    score,
    count: csatDist.get(score) ?? 0,
  }));

  return {
    total,
    open,
    closed,
    resolved,
    closedByAgent,
    closedByManager,
    agentPercent,
    avgFirstResponseMs,
    avgFirstResponseFormatted: avgFirstResponseMs
      ? formatDuration(avgFirstResponseMs)
      : "—",
    topCategories,
    byStatus,
    byPriority,
    bySource,
    slaBreachedCount,
    slaBreachedPercent,
    csatAverage,
    csatCount,
    csatDistribution,
  };
}
