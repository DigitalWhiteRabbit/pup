"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, isToday, isYesterday } from "date-fns";
import { ru } from "date-fns/locale";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  CheckSquare,
  MessageSquare,
  Paperclip,
  Columns,
  FolderOpen,
  Shield,
  Search,
  XCircle,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Activity,
  TrendingUp,
  User,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { UserAvatar } from "@/components/ui/user-avatar";
import type { ActivityAction } from "@prisma/client";

/* ── Types ── */

type LogActor = { id: string; login: string; hasAvatar: boolean } | null;

type GlobalLogItem = {
  id: string;
  action: ActivityAction;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  taskId: string | null;
  columnId: string | null;
  workspaceId: string | null;
  actor: LogActor;
  createdAt: Date;
  workspaceName: string | null;
};

type Stats = {
  todayCount: number;
  weekCount: number;
  topActor: { login: string; count: number } | null;
};

type PaginatedGlobal = {
  data: GlobalLogItem[];
  total: number;
  stats: Stats | null;
  actors: { id: string; login: string; hasAvatar: boolean }[];
};

type WorkspaceSummary = { id: string; name: string };

/* ── Constants ── */

const ACTION_GROUPS: Record<string, ActivityAction[]> = {
  Задачи: [
    "TASK_CREATED",
    "TASK_DELETED",
    "TASK_MOVED",
    "TASK_UPDATED",
    "TASK_ASSIGNEE_ADDED",
    "TASK_ASSIGNEE_REMOVED",
    "TASK_PRIORITY_CHANGED",
    "TASK_DATE_CHANGED",
  ],
  "Комментарии и файлы": [
    "COMMENT_CREATED",
    "COMMENT_UPDATED",
    "COMMENT_DELETED",
    "ATTACHMENT_UPLOADED",
    "ATTACHMENT_DELETED",
  ],
  Колонки: ["COLUMN_CREATED", "COLUMN_RENAMED", "COLUMN_DELETED"],
  Workspace: [
    "WORKSPACE_CREATED",
    "WORKSPACE_UPDATED",
    "MEMBER_ADDED",
    "MEMBER_REMOVED",
    "MEMBER_ROLE_CHANGED",
    "MODULE_ENABLED",
    "MODULE_DISABLED",
  ],
};

const DATE_PRESETS = [
  { label: "Сегодня", value: "today" },
  { label: "Неделя", value: "week" },
  { label: "Месяц", value: "month" },
  { label: "Всё время", value: "all" },
];

const PAGE_SIZE = 50;

/* ── Action style ── */

type ActionStyle = { icon: React.ElementType; colorClass: string };

function getActionStyle(action: ActivityAction): ActionStyle {
  if (action === "TASK_CREATED")
    return {
      icon: CheckSquare,
      colorClass:
        "text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/50",
    };
  if (action === "TASK_DELETED")
    return {
      icon: CheckSquare,
      colorClass:
        "text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/50",
    };
  if (
    action === "TASK_MOVED" ||
    action === "TASK_PRIORITY_CHANGED" ||
    action === "TASK_DATE_CHANGED"
  )
    return {
      icon: CheckSquare,
      colorClass:
        "text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/50",
    };
  if (action.startsWith("TASK_"))
    return {
      icon: CheckSquare,
      colorClass:
        "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/50",
    };
  if (action === "COMMENT_CREATED")
    return {
      icon: MessageSquare,
      colorClass:
        "text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/50",
    };
  if (action === "COMMENT_DELETED")
    return {
      icon: MessageSquare,
      colorClass:
        "text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/50",
    };
  if (action.startsWith("COMMENT_"))
    return {
      icon: MessageSquare,
      colorClass:
        "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/50",
    };
  if (action === "ATTACHMENT_UPLOADED")
    return {
      icon: Paperclip,
      colorClass:
        "text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/50",
    };
  if (action === "ATTACHMENT_DELETED")
    return {
      icon: Paperclip,
      colorClass:
        "text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/50",
    };
  if (action.startsWith("COLUMN_"))
    return {
      icon: Columns,
      colorClass:
        "text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-900/50",
    };
  if (
    action === "MEMBER_ADDED" ||
    action === "WORKSPACE_CREATED" ||
    action === "MODULE_ENABLED"
  )
    return {
      icon: FolderOpen,
      colorClass:
        "text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-900/50",
    };
  if (action === "MEMBER_REMOVED" || action === "MODULE_DISABLED")
    return {
      icon: FolderOpen,
      colorClass:
        "text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/50",
    };
  if (action.startsWith("WORKSPACE_") || action.startsWith("MEMBER_"))
    return {
      icon: FolderOpen,
      colorClass:
        "text-indigo-600 dark:text-indigo-400 bg-indigo-100 dark:bg-indigo-900/50",
    };
  return { icon: Shield, colorClass: "text-muted-foreground bg-muted" };
}

/* ── Diff viewer for UPDATED actions ── */

function DiffView({ metadata }: { metadata: Record<string, unknown> }) {
  const changes = metadata.changes as
    | Record<string, { from: unknown; to: unknown }>
    | undefined;
  const oldValues = metadata.old as Record<string, unknown> | undefined;
  const newValues = metadata.new as Record<string, unknown> | undefined;

  // Format: { changes: { field: { from, to } } } or { old: {}, new: {} }
  const diffs: { field: string; from: string; to: string }[] = [];

  if (changes) {
    for (const [k, v] of Object.entries(changes)) {
      diffs.push({
        field: k,
        from: String(v.from ?? "—"),
        to: String(v.to ?? "—"),
      });
    }
  } else if (oldValues && newValues) {
    const allKeys = [
      ...Object.keys(oldValues),
      ...Object.keys(newValues),
    ].filter((k, i, a) => a.indexOf(k) === i);
    for (const k of allKeys) {
      if (String(oldValues[k]) !== String(newValues[k])) {
        diffs.push({
          field: k,
          from: String(oldValues[k] ?? "—"),
          to: String(newValues[k] ?? "—"),
        });
      }
    }
  }

  if (diffs.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      {diffs.map((d) => (
        <div key={d.field} className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground font-medium min-w-[60px]">
            {d.field}:
          </span>
          <span className="line-through text-red-400/70">{d.from}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          <span className="text-emerald-400">{d.to}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Log row ── */

function LogRow({ log }: { log: GlobalLogItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = Object.keys(log.metadata).length > 0;
  const isSystem = !log.actor;
  const style = getActionStyle(log.action);
  const Icon = style.icon;
  const isUpdate =
    log.action.includes("UPDATED") ||
    log.action.includes("CHANGED") ||
    log.action.includes("RENAMED") ||
    log.action.includes("MOVED");
  const hasDiff = isUpdate && hasMetadata;

  // Build entity link
  let entityLink: string | null = null;
  if (log.workspaceId && log.taskId) {
    entityLink = `/workspaces/${log.workspaceId}/crm?taskId=${log.taskId}`;
  } else if (log.workspaceId && log.entityType === "TICKET" && log.entityId) {
    entityLink = `/workspaces/${log.workspaceId}/tickets/${log.entityId}`;
  }

  return (
    <div className="flex items-start gap-3 p-4 hover:bg-muted/30 transition-colors duration-200">
      <div className={`flex-shrink-0 p-2 rounded-full ${style.colorClass}`}>
        <Icon className="h-4 w-4" aria-hidden />
      </div>

      <div className="flex-grow min-w-0">
        <div className="flex items-start gap-2">
          <p className="text-sm font-medium text-foreground leading-snug flex-1">
            {log.summary}
            {entityLink && (
              <Link
                href={entityLink}
                className="inline-flex items-center gap-0.5 ml-1.5 text-emerald-500 hover:text-emerald-400 transition-colors"
                title="Открыть"
              >
                <ExternalLink className="h-3 w-3" />
              </Link>
            )}
          </p>
        </div>

        {/* Diff for update actions */}
        {hasDiff && <DiffView metadata={log.metadata} />}

        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {log.actor ? (
            <span className="inline-flex items-center gap-1.5">
              <UserAvatar
                userId={log.actor.hasAvatar ? log.actor.id : undefined}
                login={log.actor.login}
                size={18}
              />
              <span className="text-[11px] font-medium text-muted-foreground">
                {log.actor.login}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-500">
              <Shield className="h-3 w-3" /> Система
            </span>
          )}
          <span className="text-[10px] text-muted-foreground/40">·</span>
          {log.workspaceName && (
            <>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                {log.workspaceName}
              </span>
              <span className="text-[10px] text-muted-foreground/40">·</span>
            </>
          )}
          {!log.workspaceName && isSystem && (
            <>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 font-medium">
                Системное
              </span>
              <span className="text-[10px] text-muted-foreground/40">·</span>
            </>
          )}
          <span
            className="text-[11px] text-muted-foreground"
            title={format(new Date(log.createdAt), "d MMMM yyyy, HH:mm:ss", {
              locale: ru,
            })}
          >
            {format(new Date(log.createdAt), "HH:mm", { locale: ru })}
          </span>
          {hasMetadata && !hasDiff && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors flex items-center gap-0.5 ml-1"
            >
              {expanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {expanded ? "Скрыть" : "JSON"}
            </button>
          )}
        </div>

        {expanded && hasMetadata && (
          <pre className="mt-2.5 text-[11px] bg-muted/50 border border-border/40 rounded-lg p-3 overflow-auto max-h-40 text-muted-foreground font-mono">
            {JSON.stringify(log.metadata, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ── Day separator ── */

function DaySeparator({ date }: { date: Date }) {
  const d = new Date(date);
  let label: string;
  if (isToday(d)) label = "Сегодня";
  else if (isYesterday(d)) label = "Вчера";
  else label = format(d, "d MMMM yyyy", { locale: ru });

  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <div className="h-px flex-1 bg-border/50" />
      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider shrink-0">
        {label}
      </span>
      <div className="h-px flex-1 bg-border/50" />
    </div>
  );
}

/* ── Stats cards ── */

function StatsCards({ stats }: { stats: Stats }) {
  return (
    <div className="grid grid-cols-3 gap-3 mb-5">
      <Card className="shadow-none border-border/60">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">
              {stats.todayCount}
            </div>
            <div className="text-[11px] text-muted-foreground">Сегодня</div>
          </div>
        </CardContent>
      </Card>
      <Card className="shadow-none border-border/60">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400">
            <TrendingUp className="h-4 w-4" />
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">
              {stats.weekCount}
            </div>
            <div className="text-[11px] text-muted-foreground">За неделю</div>
          </div>
        </CardContent>
      </Card>
      <Card className="shadow-none border-border/60">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="p-2 rounded-full bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400">
            <User className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-bold text-foreground truncate">
              {stats.topActor?.login ?? "—"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {stats.topActor
                ? `${stats.topActor.count} действий за неделю`
                : "Нет данных"}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Skeletons ── */

function LogSkeletons() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 p-4">
          <Skeleton className="h-8 w-8 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Timeline grouping ── */

function TimelineLogList({ logs }: { logs: GlobalLogItem[] }) {
  const grouped = useMemo(() => {
    const groups: { date: string; logs: GlobalLogItem[] }[] = [];
    for (const log of logs) {
      const dayKey = format(new Date(log.createdAt), "yyyy-MM-dd");
      const last = groups[groups.length - 1];
      if (last && last.date === dayKey) {
        last.logs.push(log);
      } else {
        groups.push({ date: dayKey, logs: [log] });
      }
    }
    return groups;
  }, [logs]);

  return (
    <>
      {grouped.map((group) => (
        <div key={group.date}>
          <DaySeparator date={new Date(group.date)} />
          <div className="divide-y divide-border/30">
            {group.logs.map((log) => (
              <LogRow key={log.id} log={log} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ── Main ── */

export function GlobalLogsClient() {
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState("all");
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [actorFilter, setActorFilter] = useState("all");
  const [datePreset, setDatePreset] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"activity" | "system">("activity");
  const [newCount, setNewCount] = useState(0);
  const prevTotalRef = useRef<number | null>(null);

  const { data: workspaces } = useQuery<{ data: WorkspaceSummary[] }>({
    queryKey: ["workspaces-global-logs"],
    queryFn: () => fetch("/api/workspaces?limit=100").then((r) => r.json()),
    staleTime: 60_000,
  });

  // Date range from preset
  function getDateRange(): { from?: string; to?: string } {
    const now = new Date();
    if (datePreset === "today") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.toISOString() };
    }
    if (datePreset === "week") {
      return { from: new Date(Date.now() - 7 * 86400000).toISOString() };
    }
    if (datePreset === "month") {
      return { from: new Date(Date.now() - 30 * 86400000).toISOString() };
    }
    return {};
  }

  const dateRange = getDateRange();
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    stats: "true",
  });
  if (actionFilter !== "all") {
    const actions = ACTION_GROUPS[actionFilter];
    if (actions) params.set("actions", actions.join(","));
  }
  if (workspaceFilter !== "all") params.set("workspaceId", workspaceFilter);
  if (actorFilter !== "all") params.set("actorId", actorFilter);
  if (dateRange.from) params.set("from", dateRange.from);
  if (dateRange.to) params.set("to", dateRange.to);
  if (search) params.set("search", search);
  if (tab === "system") params.set("systemOnly", "true");

  const { data, isLoading } = useQuery<PaginatedGlobal>({
    queryKey: [
      "global-activity-logs",
      page,
      actionFilter,
      workspaceFilter,
      actorFilter,
      datePreset,
      search,
      tab,
    ],
    queryFn: () =>
      fetch(`/api/logs/activity?${params.toString()}`).then((r) => r.json()),
    refetchInterval: 10_000,
  });

  // Realtime: detect new events
  useEffect(() => {
    if (!data || page !== 1) return;
    if (prevTotalRef.current !== null && data.total > prevTotalRef.current) {
      setNewCount((c) => c + (data.total - prevTotalRef.current!));
    }
    prevTotalRef.current = data.total;
  }, [data, page]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 1;
  const hasFilters =
    actionFilter !== "all" ||
    workspaceFilter !== "all" ||
    actorFilter !== "all" ||
    datePreset !== "all" ||
    search !== "";

  function reset() {
    setActionFilter("all");
    setWorkspaceFilter("all");
    setActorFilter("all");
    setDatePreset("all");
    setSearch("");
    setSearchInput("");
    setPage(1);
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground">Логи активности</h1>
        {data && (
          <p className="text-sm text-muted-foreground mt-1">
            {data.total} событий
          </p>
        )}
      </div>

      {/* Stats */}
      {data?.stats && tab === "activity" && <StatsCards stats={data.stats} />}

      {/* Tabs: Activity / System */}
      <div className="flex gap-1 mb-4 p-1 bg-muted/50 rounded-lg w-fit">
        <button
          onClick={() => {
            setTab("activity");
            setPage(1);
            setNewCount(0);
            prevTotalRef.current = null;
          }}
          className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === "activity" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          Активность
        </button>
        <button
          onClick={() => {
            setTab("system");
            setPage(1);
          }}
          className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${tab === "system" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          <Shield className="h-3 w-3" /> Системные
        </button>
      </div>

      {/* New events banner */}
      {newCount > 0 && page === 1 && (
        <button
          onClick={() => {
            setNewCount(0);
            prevTotalRef.current = null;
          }}
          className="w-full mb-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 text-xs font-medium hover:bg-emerald-500/15 transition-colors"
        >
          {newCount} новых событий — нажмите для обновления
        </button>
      )}

      {/* Filters */}
      <Card className="mb-5 shadow-none border-border/60">
        <CardContent className="py-3 px-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* Date presets */}
            <div className="flex gap-1 p-0.5 bg-muted/50 rounded-lg">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => {
                    setDatePreset(p.value);
                    setPage(1);
                  }}
                  className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors ${datePreset === p.value ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <Select
              value={workspaceFilter}
              onValueChange={(v) => {
                setWorkspaceFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40 h-8 text-[11px]">
                <SelectValue placeholder="Проект" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все проекты</SelectItem>
                {workspaces?.data?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={actionFilter}
              onValueChange={(v) => {
                setActionFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40 h-8 text-[11px]">
                <SelectValue placeholder="Тип" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все события</SelectItem>
                {Object.keys(ACTION_GROUPS).map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Actor filter */}
            {data?.actors && data.actors.length > 0 && (
              <Select
                value={actorFilter}
                onValueChange={(v) => {
                  setActorFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-40 h-8 text-[11px]">
                  <SelectValue placeholder="Автор" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все авторы</SelectItem>
                  {data.actors.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.login}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <form
              className="flex items-center gap-1 flex-1 min-w-[140px]"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(searchInput.trim());
                setPage(1);
              }}
            >
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  placeholder="Поиск..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="h-8 text-[11px] pl-7"
                />
              </div>
            </form>

            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={reset}
                className="h-8 text-[11px] text-muted-foreground"
              >
                <XCircle className="h-3 w-3 mr-1" /> Сбросить
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Log feed */}
      <Card className="shadow-none border-border/60 overflow-hidden">
        <CardContent className="p-0">
          {isLoading ? (
            <LogSkeletons />
          ) : !data || data.data.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              Событий не найдено
            </div>
          ) : (
            <TimelineLogList logs={data.data} />
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && totalPages > 1 && (
        <div className="flex items-center justify-between pt-4">
          <span className="text-xs text-muted-foreground">
            Страница {page} из {totalPages}
          </span>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
