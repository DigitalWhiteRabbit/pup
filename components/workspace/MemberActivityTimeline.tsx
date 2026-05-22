"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ru } from "date-fns/locale";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Eye,
  MousePointerClick,
  ChevronLeft,
  ChevronRight,
  Activity,
  Loader2,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type ClickLog = {
  id: string;
  userId: string;
  action: string;
  target: string;
  details: string | null;
  occurredAt: string;
};

type ClickLogsResponse = {
  data: ClickLog[];
  total: number;
};

type Member = {
  id: string;
  login: string;
  role: string;
};

type Props = {
  workspaceId: string;
  members: Member[];
};

// ─── Action formatting ──────────────────────────────────────────────────────

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

const ACTION_LABELS: Record<string, string> = {
  // CRM
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
  // Marketing
  "marketing:lead:launch": "Запустил outreach для лида",
  "marketing:lead:create": "Создал лида",
  "marketing:lead:enrich": "Обогатил лида",
  "marketing:lead:score": "Оценил лида",
  "marketing:pitch:approve": "Одобрил pitch",
  "marketing:pitch:reject": "Отклонил pitch",
  "marketing:parser:start": "Запустил парсер",
  "marketing:project:create": "Создал проект",
  "marketing:project:update": "Обновил проект",
  // Tickets
  "tickets:create": "Создал тикет",
  "tickets:status:change": "Изменил статус тикета",
  "tickets:assign": "Назначил тикет",
  "tickets:message:send": "Отправил сообщение в тикет",
  // Chat
  "chat:message:send": "Отправил сообщение",
  "chat:channel:create": "Создал канал",
  "chat:reaction:add": "Поставил реакцию",
  // Knowledge
  "knowledge:article:create": "Создал статью",
  "knowledge:article:update": "Обновил статью",
  "knowledge:file:upload": "Загрузил файл в БЗ",
  "knowledge:crawl:start": "Запустил краулинг",
  // Voice
  "voice:join": "Зашёл в голосовой",
  "voice:leave": "Вышел из голосового",
  // Workspace
  "workspace:member:add": "Добавил участника",
  "workspace:member:remove": "Удалил участника",
  "workspace:settings:update": "Обновил настройки",
  "workspace:module:toggle": "Переключил модуль",
};

function formatAction(action: string, target: string): string {
  // 1. Check exact match in ACTION_LABELS
  if (ACTION_LABELS[target]) return ACTION_LABELS[target];

  // 2. For page_view, extract module from path
  if (action === "page_view") {
    // /workspaces/xxx/crm -> "crm"
    const pathMatch = target.match(/\/workspaces\/[^/]+\/([a-z-]+)/);
    if (pathMatch) {
      const moduleKey = pathMatch[1];
      const label =
        (moduleKey && MODULE_LABELS[moduleKey]) || moduleKey || target;
      return `Открыл ${label}`;
    }
    // /workspaces/xxx -> workspace overview
    if (target.match(/\/workspaces\/[^/]+$/)) {
      return "Открыл обзор workspace";
    }
    // /workspaces -> workspace list
    if (target === "/workspaces") {
      return "Открыл список workspace";
    }
    return `Открыл ${target}`;
  }

  // 3. Fallback: use action directly
  return `${action}: ${target}`;
}

function getActionColor(action: string): string {
  switch (action) {
    case "page_view":
      return "bg-blue-500";
    case "button_click":
      return "bg-amber-500";
    case "module_open":
      return "bg-emerald-500";
    default:
      if (action.includes("create") || action.includes("add"))
        return "bg-emerald-500";
      if (action.includes("delete") || action.includes("remove"))
        return "bg-red-500";
      if (action.includes("update") || action.includes("change"))
        return "bg-amber-500";
      return "bg-violet-500";
  }
}

function getActionIcon(action: string) {
  if (action === "page_view") return <Eye className="h-3 w-3" />;
  return <MousePointerClick className="h-3 w-3" />;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function MemberActivityTimeline({ workspaceId, members }: Props) {
  const [selectedMemberId, setSelectedMemberId] = useState<string>("all");
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
    if (selectedMemberId !== "all") p.set("userId", selectedMemberId);
    return p.toString();
  }, [selectedDate, selectedMemberId, page]);

  const { data, isLoading, isFetching } = useQuery<ClickLogsResponse>({
    queryKey: ["click-logs", workspaceId, selectedMemberId, selectedDate, page],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/click-logs?${params}`).then((r) =>
        r.json(),
      ),
    refetchInterval: 30_000,
  });

  const logs = useMemo(() => data?.data ?? [], [data?.data]);
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Group logs by hour for display
  const groupedByHour = useMemo(() => {
    const groups: Record<string, ClickLog[]> = {};
    for (const log of logs) {
      const hour = format(new Date(log.occurredAt), "HH:00");
      if (!groups[hour]) groups[hour] = [];
      groups[hour].push(log);
    }
    // Sort hours descending
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [logs]);

  // Date navigation
  function goDate(offset: number) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + offset);
    setSelectedDate(format(d, "yyyy-MM-dd"));
    setPage(0);
  }

  const isToday = selectedDate === format(new Date(), "yyyy-MM-dd");

  // Map member IDs to logins for display
  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const member of members) {
      m.set(member.id, member.login);
    }
    return m;
  }, [members]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Активность участников
            {isFetching && !isLoading && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </CardTitle>
          <Badge variant="secondary" className="text-xs font-normal">
            {total} событий
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Date navigation */}
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
                : format(new Date(selectedDate), "d MMM", { locale: ru })}
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

          {/* Member filter */}
          <Select
            value={selectedMemberId}
            onValueChange={(v) => {
              setSelectedMemberId(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-36 h-7 text-xs">
              <SelectValue placeholder="Участник" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все участники</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.login}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-xs">Нет активности за этот день</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[400px] overflow-y-auto pr-1">
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
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${getActionColor(log.action)}`}
                      />
                      <span className="text-muted-foreground opacity-60">
                        {getActionIcon(log.action)}
                      </span>
                      {selectedMemberId === "all" && (
                        <span className="font-medium text-muted-foreground shrink-0">
                          {memberMap.get(log.userId) ?? "?"}
                        </span>
                      )}
                      <span className="truncate">
                        {formatAction(log.action, log.target)}
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
              {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)}{" "}
              из {total}
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
      </CardContent>
    </Card>
  );
}
