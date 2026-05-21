"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  UserCheck,
  Clock,
  BarChart3,
  Tag,
  Inbox,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type Analytics = {
  total: number;
  open: number;
  closed: number;
  resolved: number;
  closedByAgent: number;
  closedByManager: number;
  agentPercent: number;
  avgFirstResponseMs: number | null;
  avgFirstResponseFormatted: string;
  topCategories: Array<{ category: string; count: number; percent: number }>;
  byStatus: Array<{ status: string; count: number }>;
  byPriority: Array<{ priority: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
  slaBreachedCount: number;
  slaBreachedPercent: number;
  csatAverage: number | null;
  csatCount: number;
  csatDistribution: Array<{ score: number; count: number }>;
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Открытые",
  IN_PROGRESS: "В работе",
  WAITING_CUSTOMER: "Ждут клиента",
  RESOLVED: "Решённые",
  CLOSED: "Закрытые",
};

const PRIORITY_LABELS: Record<string, string> = {
  LOW: "Низкий",
  MEDIUM: "Средний",
  HIGH: "Высокий",
  URGENT: "Срочный",
};

const SOURCE_LABELS: Record<string, string> = {
  INTERNAL: "Внутренние",
  EXTERNAL: "Внешние (чат)",
};

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color: string;
}) {
  return (
    <div className="border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${color}15` }}
        >
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function BarItem({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 text-xs text-muted-foreground shrink-0">{label}</div>
      <div className="flex-1 h-6 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color }}
        />
      </div>
      <div className="w-12 text-xs text-muted-foreground text-right">
        {count}{" "}
        <span className="text-muted-foreground/70">({Math.round(pct)}%)</span>
      </div>
    </div>
  );
}

export function TicketAnalyticsClient({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const { data, isLoading } = useQuery<Analytics>({
    queryKey: ["ticket-analytics", workspaceId],
    queryFn: async () => {
      const r = await fetch(`/api/workspaces/${workspaceId}/tickets/analytics`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  if (isLoading || !data) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    OPEN: "#22c55e",
    IN_PROGRESS: "#3b82f6",
    WAITING_CUSTOMER: "#f59e0b",
    RESOLVED: "#6b7280",
    CLOSED: "#9ca3af",
  };

  const priorityColors: Record<string, string> = {
    LOW: "#9ca3af",
    MEDIUM: "#f59e0b",
    HIGH: "#f97316",
    URGENT: "#ef4444",
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/workspaces/${workspaceId}/tickets`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold">Аналитика тикетов</h1>
          <p className="text-sm text-muted-foreground">
            Метрики и статистика поддержки
          </p>
        </div>
      </div>

      {/* Top cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          icon={Inbox}
          label="Всего тикетов"
          value={data.total}
          sub={`${data.open} открытых`}
          color="#3b82f6"
        />
        <StatCard
          icon={Clock}
          label="Среднее время ответа"
          value={data.avgFirstResponseFormatted}
          sub="первый ответ менеджера"
          color="#8b5cf6"
        />
        <StatCard
          icon={Bot}
          label="Закрыто ИИ"
          value={`${data.agentPercent}%`}
          sub={`${data.closedByAgent} из ${data.closedByAgent + data.closedByManager}`}
          color="#06b6d4"
        />
        <StatCard
          icon={Star}
          label="CSAT"
          value={data.csatAverage ? `${data.csatAverage}/5` : "—"}
          sub={`${data.csatCount} оценок${data.slaBreachedCount > 0 ? ` · ${data.slaBreachedCount} SLA нарушений` : ""}`}
          color="#f59e0b"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* AI vs Менеджеры */}
        <div className="border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <UserCheck className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              Закрыто: ИИ vs Менеджеры
            </h3>
          </div>
          <div className="flex gap-4 mb-3">
            <div className="flex-1 text-center p-3 bg-cyan-50 dark:bg-cyan-900/20 rounded-lg">
              <div className="text-2xl font-bold text-cyan-700 dark:text-cyan-400">
                {data.closedByAgent}
              </div>
              <div className="text-xs text-cyan-600 dark:text-cyan-500">
                ИИ-агент
              </div>
            </div>
            <div className="flex-1 text-center p-3 bg-emerald-50 dark:bg-emerald-900/20 rounded-lg">
              <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                {data.closedByManager}
              </div>
              <div className="text-xs text-emerald-600 dark:text-emerald-500">
                Менеджеры
              </div>
            </div>
          </div>
          {data.closedByAgent + data.closedByManager > 0 && (
            <div className="h-3 bg-muted rounded-full overflow-hidden flex">
              <div
                className="h-full bg-cyan-500 transition-all"
                style={{ width: `${data.agentPercent}%` }}
              />
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${100 - data.agentPercent}%` }}
              />
            </div>
          )}
          {data.closedByAgent + data.closedByManager === 0 && (
            <p className="text-xs text-muted-foreground text-center">
              Нет закрытых тикетов
            </p>
          )}
        </div>

        {/* Топ категорий */}
        <div className="border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              Топ категорий
            </h3>
          </div>
          {data.topCategories.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              Нет данных
            </p>
          ) : (
            <div className="space-y-2.5">
              {data.topCategories.map((c) => (
                <BarItem
                  key={c.category}
                  label={c.category}
                  count={c.count}
                  total={data.total}
                  color="#8b5cf6"
                />
              ))}
            </div>
          )}
        </div>

        {/* По статусам */}
        <div className="border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              По статусам
            </h3>
          </div>
          <div className="space-y-2.5">
            {data.byStatus.map((s) => (
              <BarItem
                key={s.status}
                label={STATUS_LABELS[s.status] ?? s.status}
                count={s.count}
                total={data.total}
                color={statusColors[s.status] ?? "#6b7280"}
              />
            ))}
          </div>
        </div>

        {/* По приоритетам + источникам */}
        <div className="border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              По приоритетам
            </h3>
          </div>
          <div className="space-y-2.5 mb-5">
            {data.byPriority.map((p) => (
              <BarItem
                key={p.priority}
                label={PRIORITY_LABELS[p.priority] ?? p.priority}
                count={p.count}
                total={data.total}
                color={priorityColors[p.priority] ?? "#6b7280"}
              />
            ))}
          </div>
          <div className="text-xs font-semibold text-muted-foreground mb-2">
            По источникам
          </div>
          <div className="space-y-2.5">
            {data.bySource.map((s) => (
              <BarItem
                key={s.source}
                label={SOURCE_LABELS[s.source] ?? s.source}
                count={s.count}
                total={data.total}
                color="#3b82f6"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
