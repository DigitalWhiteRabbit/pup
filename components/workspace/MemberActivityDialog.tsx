"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Clock,
  Calendar,
  TrendingUp,
  Activity,
  Eye,
  MousePointerClick,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type ActivityDay = {
  date: string;
  minutesActive: number;
  heartbeats: number;
  firstSeen: string | null;
  lastSeen: string | null;
};

type ActivityResponse = {
  member: { id: string; login: string; role: string } | null;
  period: string;
  data: ActivityDay[];
  summary: {
    totalMinutes: number;
    avgMinutesPerDay: number;
    daysActive: number;
  };
};

type Period = "day" | "week" | "month";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMinutes(minutes: number): string {
  if (minutes === 0) return "0 мин";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDate();
  const months = [
    "янв",
    "фев",
    "мар",
    "апр",
    "май",
    "июн",
    "июл",
    "авг",
    "сен",
    "окт",
    "ноя",
    "дек",
  ];
  return `${day} ${months[d.getMonth()]}`;
}

function formatWeekday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  return days[d.getDay()] ?? "?";
}

const PERIOD_LABELS: Record<Period, string> = {
  day: "День",
  week: "Неделя",
  month: "Месяц",
};

// ─── Click-log types ─────────────────────────────────────────────────────────

type ClickLog = {
  id: string;
  action: string;
  target: string;
  details: string | null;
  occurredAt: string;
};

type ClickLogsResponse = {
  data: ClickLog[];
  total: number;
};

// ─── Click-log formatting ────────────────────────────────────────────────────

const MODULE_LABELS: Record<string, string> = {
  crm: "CRM",
  knowledge: "База знаний",
  tickets: "Тикеты",
  logs: "Логи",
  chat: "Чат",
  marketing: "Маркетинг",
  analytics: "Аналитика",
  users: "Пользователи",
  dashboard: "Dashboard",
  voice: "Голосовой канал",
};

const CL_ACTION_LABELS: Record<string, string> = {
  "crm:task:create": "Создал задачу",
  "crm:task:update": "Обновил задачу",
  "crm:task:delete": "Удалил задачу",
  "crm:task:move": "Переместил задачу",
  "crm:column:create": "Создал колонку",
  "crm:column:rename": "Переименовал колонку",
  "crm:column:delete": "Удалил колонку",
  "crm:comment:create": "Написал комментарий",
  "crm:attachment:upload": "Загрузил файл",
  "crm:timer:start": "Запустил таймер",
  "crm:timer:stop": "Остановил таймер",
  "marketing:lead:launch": "Запустил outreach для лида",
  "marketing:lead:create": "Создал лида",
  "marketing:lead:enrich": "Обогатил лида",
  "marketing:lead:score": "Оценил лида",
  "marketing:pitch:approve": "Одобрил pitch",
  "marketing:pitch:reject": "Отклонил pitch",
  "marketing:parser:start": "Запустил парсер",
  "marketing:project:create": "Создал проект",
  "marketing:project:update": "Обновил проект",
  "tickets:create": "Создал тикет",
  "tickets:status:change": "Изменил статус тикета",
  "tickets:assign": "Назначил тикет",
  "tickets:message:send": "Отправил сообщение в тикет",
  "chat:message:send": "Отправил сообщение",
  "chat:channel:create": "Создал канал",
  "chat:reaction:add": "Поставил реакцию",
  "knowledge:article:create": "Создал статью",
  "knowledge:article:update": "Обновил статью",
  "knowledge:file:upload": "Загрузил файл в БЗ",
  "knowledge:crawl:start": "Запустил краулинг",
  "voice:join": "Зашёл в голосовой",
  "voice:leave": "Вышел из голосового",
  "workspace:member:add": "Добавил участника",
  "workspace:member:remove": "Удалил участника",
  "workspace:settings:update": "Обновил настройки",
  "workspace:module:toggle": "Переключил модуль",
};

function formatClickAction(action: string, target: string): string {
  if (CL_ACTION_LABELS[target]) return CL_ACTION_LABELS[target];
  if (action === "page_view") {
    const pathMatch = target.match(/\/workspaces\/[^/]+\/([a-z-]+)/);
    if (pathMatch) {
      const moduleKey = pathMatch[1];
      const label =
        (moduleKey && MODULE_LABELS[moduleKey]) || moduleKey || target;
      return `Открыл ${label}`;
    }
    if (target.match(/\/workspaces\/[^/]+$/)) return "Открыл обзор workspace";
    if (target === "/workspaces") return "Открыл список workspace";
    return `Открыл ${target}`;
  }
  return `${action}: ${target}`;
}

function getClickActionColor(action: string): string {
  if (action === "page_view") return "bg-blue-500";
  if (action === "button_click") return "bg-amber-500";
  if (action.includes("create") || action.includes("add"))
    return "bg-emerald-500";
  if (action.includes("delete") || action.includes("remove"))
    return "bg-red-500";
  if (action.includes("update") || action.includes("change"))
    return "bg-amber-500";
  return "bg-violet-500";
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchMemberActivity(
  workspaceId: string,
  memberId: string,
  period: Period,
  date?: string,
): Promise<ActivityResponse> {
  const params = new URLSearchParams({ period });
  if (date) params.set("date", date);
  const res = await fetch(
    `/api/workspaces/${workspaceId}/members/${memberId}/activity?${params}`,
  );
  if (!res.ok) throw new Error("Failed to fetch activity");
  return res.json() as Promise<ActivityResponse>;
}

// ─── Bar Chart ───────────────────────────────────────────────────────────────

function ActivityChart({
  data,
  period,
}: {
  data: ActivityDay[];
  period: Period;
}) {
  const maxMinutes = Math.max(...data.map((d) => d.minutesActive), 1);
  const barMaxHeight = 160;

  return (
    <div className="flex items-end gap-1 justify-center min-h-[200px] pt-6 pb-2">
      {data.map((d) => {
        const height = (d.minutesActive / maxMinutes) * barMaxHeight;
        const isEmpty = d.minutesActive === 0;

        return (
          <div
            key={d.date}
            className="flex flex-col items-center gap-1 group relative"
            style={{ minWidth: period === "month" ? "12px" : "32px" }}
          >
            {/* Tooltip */}
            <div className="absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center z-10">
              <div className="bg-popover border rounded-md px-2 py-1 text-xs shadow-md whitespace-nowrap">
                <p className="font-medium">{formatDateShort(d.date)}</p>
                <p className="text-muted-foreground">
                  {formatMinutes(d.minutesActive)}
                </p>
                {d.firstSeen && d.lastSeen && (
                  <p className="text-muted-foreground">
                    {d.firstSeen} — {d.lastSeen}
                  </p>
                )}
              </div>
            </div>

            {/* Bar */}
            <div
              className={`rounded-t transition-all duration-300 ${
                isEmpty
                  ? "bg-muted"
                  : "bg-emerald-500 dark:bg-emerald-400 group-hover:bg-emerald-600 dark:group-hover:bg-emerald-300"
              }`}
              style={{
                height: `${isEmpty ? 2 : Math.max(height, 4)}px`,
                width: period === "month" ? "8px" : "24px",
              }}
            />

            {/* Label */}
            {period !== "month" && (
              <span className="text-[10px] text-muted-foreground leading-none">
                {formatWeekday(d.date)}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground leading-none">
              {period === "month"
                ? new Date(d.date + "T12:00:00").getDate().toString()
                : formatDateShort(d.date)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Summary Cards ───────────────────────────────────────────────────────────

function SummaryCards({ summary }: { summary: ActivityResponse["summary"] }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="rounded-lg border bg-card p-3 text-center">
        <Clock className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
        <p className="text-lg font-bold">
          {formatMinutes(summary.totalMinutes)}
        </p>
        <p className="text-[11px] text-muted-foreground">Всего</p>
      </div>
      <div className="rounded-lg border bg-card p-3 text-center">
        <TrendingUp className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
        <p className="text-lg font-bold">
          {formatMinutes(summary.avgMinutesPerDay)}
        </p>
        <p className="text-[11px] text-muted-foreground">Среднее/день</p>
      </div>
      <div className="rounded-lg border bg-card p-3 text-center">
        <Calendar className="h-4 w-4 mx-auto mb-1 text-muted-foreground" />
        <p className="text-lg font-bold">{summary.daysActive}</p>
        <p className="text-[11px] text-muted-foreground">Дней активен</p>
      </div>
    </div>
  );
}

// ─── Click-Log Timeline ─────────────────────────────────────────────────────

function ClickLogTimeline({
  workspaceId,
  memberId,
  enabled,
}: {
  workspaceId: string;
  memberId: string;
  enabled: boolean;
}) {
  const [selectedDate, setSelectedDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("date", selectedDate);
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(page * PAGE_SIZE));
    return p.toString();
  }, [selectedDate, page]);

  const { data, isLoading, isFetching } = useQuery<ClickLogsResponse>({
    queryKey: ["member-click-logs", workspaceId, memberId, selectedDate, page],
    queryFn: () =>
      fetch(
        `/api/workspaces/${workspaceId}/members/${memberId}/click-logs?${params}`,
      ).then((r) => r.json()),
    enabled,
    refetchInterval: 30_000,
  });

  const logs = useMemo(() => data?.data ?? [], [data?.data]);
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Group logs by hour
  const groupedByHour = useMemo(() => {
    const groups: Record<string, ClickLog[]> = {};
    for (const log of logs) {
      const hour = format(new Date(log.occurredAt), "HH:00");
      if (!groups[hour]) groups[hour] = [];
      groups[hour].push(log);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [logs]);

  function goDate(offset: number) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    setSelectedDate(format(d, "yyyy-MM-dd"));
    setPage(0);
  }

  const isToday = selectedDate === format(new Date(), "yyyy-MM-dd");

  return (
    <div className="space-y-3">
      {/* Date nav + badge */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => goDate(-1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs font-medium min-w-[90px] text-center">
            {isToday
              ? "Сегодня"
              : format(new Date(selectedDate), "d MMM yyyy", { locale: ru })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={isToday}
            onClick={() => goDate(1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {isFetching && !isLoading && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          <Badge variant="secondary" className="text-xs font-normal">
            {total} событий
          </Badge>
        </div>
      </div>

      {/* Timeline */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-2 w-2 rounded-full" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <MousePointerClick className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p className="text-xs">Нет действий за этот день</p>
        </div>
      ) : (
        <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
          {groupedByHour.map(([hour, hourLogs]) => (
            <div key={hour}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  {hour}
                </span>
                <div className="flex-1 h-px bg-border" />
                <span className="text-[10px] text-muted-foreground">
                  {hourLogs.length}
                </span>
              </div>
              <div className="space-y-0.5 pl-1">
                {hourLogs.map((log) => (
                  <div
                    key={log.id}
                    className="flex items-center gap-2 text-xs group hover:bg-accent/50 rounded px-1 py-0.5 transition-colors"
                  >
                    <span className="text-muted-foreground w-10 shrink-0 tabular-nums">
                      {format(new Date(log.occurredAt), "HH:mm")}
                    </span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${getClickActionColor(log.action)}`}
                    />
                    <span className="text-muted-foreground opacity-60">
                      {log.action === "page_view" ? (
                        <Eye className="h-3 w-3" />
                      ) : (
                        <MousePointerClick className="h-3 w-3" />
                      )}
                    </span>
                    <span className="truncate">
                      {formatClickAction(log.action, log.target)}
                    </span>
                    {log.details && (
                      <span className="text-muted-foreground truncate opacity-0 group-hover:opacity-100 transition-opacity">
                        {log.details}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] text-muted-foreground">
            {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} из{" "}
            {total}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={page <= 0}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  memberId: string;
  memberLogin: string;
};

export function MemberActivityDialog({
  open,
  onOpenChange,
  workspaceId,
  memberId,
  memberLogin,
}: Props) {
  const [period, setPeriod] = useState<Period>("week");
  const [activeTab, setActiveTab] = useState<string>("time");

  const { data, isLoading } = useQuery({
    queryKey: ["member-activity", workspaceId, memberId, period],
    queryFn: () => fetchMemberActivity(workspaceId, memberId, period),
    enabled: open && activeTab === "time",
    staleTime: 30_000,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Активность: {memberLogin}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-3">
            <TabsTrigger value="time" className="text-xs">
              <Clock className="h-3.5 w-3.5 mr-1" />
              Время
            </TabsTrigger>
            <TabsTrigger value="actions" className="text-xs">
              <MousePointerClick className="h-3.5 w-3.5 mr-1" />
              Действия
            </TabsTrigger>
          </TabsList>

          <TabsContent value="time">
            {/* Period selector */}
            <div className="flex gap-1 rounded-lg border p-1 w-fit mb-4">
              {(["day", "week", "month"] as Period[]).map((p) => (
                <Button
                  key={p}
                  variant={period === p ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs px-3"
                  onClick={() => setPeriod(p)}
                >
                  {PERIOD_LABELS[p]}
                </Button>
              ))}
            </div>

            {isLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-[200px] w-full rounded-lg" />
                <div className="grid grid-cols-3 gap-3">
                  <Skeleton className="h-20 rounded-lg" />
                  <Skeleton className="h-20 rounded-lg" />
                  <Skeleton className="h-20 rounded-lg" />
                </div>
              </div>
            ) : data ? (
              <div className="space-y-4">
                {/* Chart */}
                <div className="rounded-lg border bg-card p-3">
                  <ActivityChart data={data.data} period={period} />
                </div>

                {/* Summary */}
                <SummaryCards summary={data.summary} />

                {/* Daily details for day/week views */}
                {period !== "month" && data.data.length <= 7 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      По дням
                    </p>
                    {data.data.map((d) => (
                      <div
                        key={d.date}
                        className="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">
                            {formatWeekday(d.date)}, {formatDateShort(d.date)}
                          </span>
                          {d.firstSeen && d.lastSeen && (
                            <span className="text-xs text-muted-foreground">
                              {d.firstSeen} — {d.lastSeen}
                            </span>
                          )}
                        </div>
                        <span
                          className={`font-mono text-sm ${
                            d.minutesActive > 0
                              ? "text-emerald-600 dark:text-emerald-400 font-medium"
                              : "text-muted-foreground"
                          }`}
                        >
                          {formatMinutes(d.minutesActive)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                Нет данных об активности
              </div>
            )}
          </TabsContent>

          <TabsContent value="actions">
            <ClickLogTimeline
              workspaceId={workspaceId}
              memberId={memberId}
              enabled={open && activeTab === "actions"}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
