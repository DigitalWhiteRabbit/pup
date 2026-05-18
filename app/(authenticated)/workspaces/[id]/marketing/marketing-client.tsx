"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  BarChart3,
  Search,
  Users,
  Settings,
  Send,
  Target,
  Play,
  Plus,
  Trash2,
  ExternalLink,
  Mail,
  Check,
  X,
  Download,
  Filter,
  Loader2,
  MessageSquare,
  DollarSign,
  TrendingUp,
  Zap,
  AlertCircle,
  Clock,
  Eye,
  ChevronRight,
  ChevronLeft,
  Megaphone,
  Youtube,
  Instagram,
  Facebook,
  Linkedin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastSuccess, toastApiError } from "@/lib/toast";

type Props = { workspaceId: string };

// API helper
const api = (workspaceId: string, path: string) =>
  `/api/workspaces/${workspaceId}/marketing${path}`;

async function fetchApi(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function postApi(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function patchApi(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Badge helpers ──

const SOURCE_COLORS: Record<string, string> = {
  YOUTUBE: "bg-red-500/10 text-red-500 border-red-500/20",
  TELEGRAM: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  INSTAGRAM: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  FACEBOOK: "bg-blue-600/10 text-blue-600 border-blue-600/20",
  LINKEDIN: "bg-blue-700/10 text-blue-700 border-blue-700/20",
};

function SourceBadge({ source }: { source: string }) {
  const cls =
    SOURCE_COLORS[source?.toUpperCase()] || "bg-muted text-muted-foreground";
  return (
    <Badge
      variant="outline"
      className={`text-[10px] font-bold uppercase ${cls}`}
    >
      {source}
    </Badge>
  );
}

const STATUS_COLORS: Record<string, string> = {
  new: "bg-muted text-muted-foreground",
  enriched: "bg-blue-500/10 text-blue-500",
  qualified: "bg-emerald-500/10 text-emerald-500",
  contacted: "bg-orange-500/10 text-orange-500",
  rejected: "bg-red-500/10 text-red-500",
  converted: "bg-emerald-500/10 text-emerald-500",
};

function StatusBadge({ status }: { status: string }) {
  const cls =
    STATUS_COLORS[status?.toLowerCase()] || "bg-muted text-muted-foreground";
  return (
    <Badge variant="outline" className={`text-[10px] font-bold ${cls}`}>
      {status}
    </Badge>
  );
}

function ScoreBadge({ score }: { score: string | number | null }) {
  if (!score && score !== 0)
    return <span className="text-muted-foreground">—</span>;
  const num = typeof score === "number" ? score : parseFloat(score);
  let cls = "bg-red-500/10 text-red-500";
  let label = "Low";
  if (num >= 0.75) {
    cls = "bg-emerald-500/10 text-emerald-500";
    label = "High";
  } else if (num >= 0.4) {
    cls = "bg-yellow-500/10 text-yellow-500";
    label = "Medium";
  }
  return (
    <Badge variant="outline" className={`text-[10px] font-bold ${cls}`}>
      {label}
    </Badge>
  );
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-emerald-500" />
      </div>
      <h3 className="text-sm font-semibold mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-sm mb-4">
        {description}
      </p>
      {action}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Dashboard
// ═══════════════════════════════════════════════════════════════

function DashboardSection({ workspaceId }: Props) {
  const { data: analytics, isLoading } = useQuery({
    queryKey: ["mkt-analytics", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/analytics")),
  });

  const { data: workerStatus } = useQuery({
    queryKey: ["mkt-worker", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/worker")),
    refetchInterval: 10000,
  });

  const { data: activity } = useQuery({
    queryKey: ["mkt-activity", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/activity")),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-3.5">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-5 gap-3.5">
          <Skeleton className="col-span-3 h-64 rounded-xl" />
          <Skeleton className="col-span-2 h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  const totalLeads = analytics?.totalLeads ?? 0;
  const activeTasksCount = analytics?.activeTasks ?? 0;
  const totalCost = analytics?.totalCost ?? 0;
  const conversionRate = analytics?.conversionRate ?? 0;
  const leadsBySource = analytics?.leadsBySource ?? [];
  const pendingActions = analytics?.pendingActions ?? {
    awaitingReply: 0,
    awaitingApproval: 0,
    newLeads: 0,
  };

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-3.5">
        <Card className="hover:border-emerald-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
              Всего лидов
            </div>
            <div className="text-3xl font-extrabold">{totalLeads}</div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <Users className="h-3 w-3" />В базе
            </div>
          </CardContent>
        </Card>

        <Card className="hover:border-emerald-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
              Активные парсеры
            </div>
            <div className="text-3xl font-extrabold">
              {activeTasksCount}
              <span className="text-xs text-muted-foreground ml-1">/5</span>
            </div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <div
                className={`h-2 w-2 rounded-full ${workerStatus?.running ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/30"}`}
              />
              Worker: {workerStatus?.running ? "Активен" : "Остановлен"}
            </div>
          </CardContent>
        </Card>

        <Card className="hover:border-emerald-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
              Расход
            </div>
            <div className="text-3xl font-extrabold">
              ${typeof totalCost === "number" ? totalCost.toFixed(2) : "0.00"}
            </div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <DollarSign className="h-3 w-3" />
              Всего
            </div>
          </CardContent>
        </Card>

        <Card className="hover:border-emerald-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
              Конверсия в ответ
            </div>
            <div className="text-3xl font-extrabold">{conversionRate}%</div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Ответили / Контакт
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Activity + Top Sources */}
      <div className="grid grid-cols-5 gap-3.5">
        <Card className="col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Последние события
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activity?.items?.length > 0 ? (
              <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
                {activity.items.map((item: any, i: number) => (
                  <div
                    key={i}
                    className="flex gap-3 p-2.5 rounded-lg bg-muted/30 border border-border text-xs"
                  >
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs ${
                        item.type === "parser_done"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : item.type === "campaign"
                            ? "bg-blue-500/10 text-blue-500"
                            : item.type === "lead"
                              ? "bg-orange-500/10 text-orange-500"
                              : item.type === "deal"
                                ? "bg-yellow-500/10 text-yellow-500"
                                : item.type === "error"
                                  ? "bg-red-500/10 text-red-500"
                                  : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {item.type === "parser_done" && (
                        <Check className="h-3 w-3" />
                      )}
                      {item.type === "campaign" && <Mail className="h-3 w-3" />}
                      {item.type === "lead" && <Zap className="h-3 w-3" />}
                      {item.type === "deal" && (
                        <DollarSign className="h-3 w-3" />
                      )}
                      {item.type === "error" && <X className="h-3 w-3" />}
                      {![
                        "parser_done",
                        "campaign",
                        "lead",
                        "deal",
                        "error",
                      ].includes(item.type) && (
                        <MessageSquare className="h-3 w-3" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{item.title}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {item.meta}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={Clock}
                title="Нет событий"
                description="Активность появится после запуска парсеров и кампаний"
              />
            )}
          </CardContent>
        </Card>

        <Card className="col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Топ источников по конверсии
            </CardTitle>
          </CardHeader>
          <CardContent>
            {leadsBySource.length > 0 ? (
              <div className="space-y-3">
                {leadsBySource.map((src: any) => (
                  <div key={src.source} className="flex items-center gap-3">
                    <SourceBadge source={src.source} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{src.source}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {src.total} лидов · {src.qualified ?? 0} qualified
                      </div>
                    </div>
                    <div className="text-sm font-bold text-emerald-500">
                      {src.conversionRate ?? 0}%
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={BarChart3}
                title="Нет данных"
                description="Запустите парсеры для сбора лидов"
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Pending actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Ожидают действия
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-orange-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-orange-500">
                {pendingActions.awaitingReply}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">
                Ждут ответа
              </div>
            </div>
            <div className="bg-yellow-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-yellow-500">
                {pendingActions.awaitingApproval}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">
                Ждут одобрения
              </div>
            </div>
            <div className="bg-blue-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-blue-500">
                {pendingActions.newLeads}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">
                Новые лиды
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Parsers
// ═══════════════════════════════════════════════════════════════

const SOURCES = [
  {
    key: "YOUTUBE",
    name: "YouTube",
    desc: "YouTube Data API v3 · Каналы, видео, контакты",
    color: "bg-red-500/10 text-red-500",
  },
  {
    key: "TELEGRAM",
    name: "Telegram",
    desc: "gramjs MTProto · Каналы, группы",
    color: "bg-blue-500/10 text-blue-500",
  },
  {
    key: "INSTAGRAM",
    name: "Instagram",
    desc: "Apify actor · Профили, посты, контакты",
    color: "bg-purple-500/10 text-purple-500",
  },
  {
    key: "FACEBOOK",
    name: "Facebook",
    desc: "Apify actor · Страницы, группы",
    color: "bg-blue-600/10 text-blue-600",
  },
  {
    key: "LINKEDIN",
    name: "LinkedIn",
    desc: "Apify actor · Профили, компании",
    color: "bg-blue-700/10 text-blue-700",
  },
];

function ParsersSection({ workspaceId }: Props) {
  const queryClient = useQueryClient();
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskForm, setNewTaskForm] = useState({
    name: "",
    source: "YOUTUBE",
    keywords: "",
    minSubscribers: 10000,
    maxResults: 50,
    country: "RU",
    schedule: "",
  });

  // Quick run form
  const [quickForm, setQuickForm] = useState({
    source: "YOUTUBE",
    query: "",
    minSubs: 10000,
    maxResults: 50,
    country: "RU",
    minEngagement: 2,
  });

  const { data: config } = useQuery({
    queryKey: ["mkt-config", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/config")),
  });

  const { data: tasks, isLoading: tasksLoading } = useQuery({
    queryKey: ["mkt-tasks", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/parsers/tasks")),
  });

  const { data: runs, isLoading: runsLoading } = useQuery({
    queryKey: ["mkt-runs", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/parsers/runs")),
  });

  const runTaskMutation = useMutation({
    mutationFn: (taskId: string) =>
      postApi(api(workspaceId, `/parsers/tasks/${taskId}/run`)),
    onSuccess: () => {
      toastSuccess("Задача запущена");
      queryClient.invalidateQueries({ queryKey: ["mkt-runs", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["mkt-tasks", workspaceId] });
    },
    onError: toastApiError,
  });

  const createTaskMutation = useMutation({
    mutationFn: (data: typeof newTaskForm) =>
      postApi(api(workspaceId, "/parsers/tasks"), data),
    onSuccess: () => {
      toastSuccess("Задача создана");
      setShowNewTask(false);
      setNewTaskForm({
        name: "",
        source: "YOUTUBE",
        keywords: "",
        minSubscribers: 10000,
        maxResults: 50,
        country: "RU",
        schedule: "",
      });
      queryClient.invalidateQueries({ queryKey: ["mkt-tasks", workspaceId] });
    },
    onError: toastApiError,
  });

  const quickRunMutation = useMutation({
    mutationFn: (data: typeof quickForm) =>
      postApi(api(workspaceId, "/parsers/run"), data),
    onSuccess: (data) => {
      toastSuccess(`Парсинг завершён: найдено ${data?.found ?? 0} результатов`);
      queryClient.invalidateQueries({ queryKey: ["mkt-runs", workspaceId] });
      queryClient.invalidateQueries({
        queryKey: ["mkt-analytics", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const sourceStatuses: Record<string, string> = {};
  if (config) {
    if (config.youtubeApiKey) sourceStatuses.YOUTUBE = "connected";
    if (config.telegramApiId) sourceStatuses.TELEGRAM = "connected";
    if (config.apifyToken) {
      sourceStatuses.INSTAGRAM = "connected";
      sourceStatuses.FACEBOOK = "connected";
      sourceStatuses.LINKEDIN = "connected";
    }
  }

  return (
    <div>
      <Tabs defaultValue="sources">
        <TabsList className="mb-4">
          <TabsTrigger value="sources">Источники</TabsTrigger>
          <TabsTrigger value="tasks">Задачи</TabsTrigger>
          <TabsTrigger value="runs">История</TabsTrigger>
          <TabsTrigger value="quick">Быстрый запуск</TabsTrigger>
        </TabsList>

        {/* Sources */}
        <TabsContent value="sources">
          <div className="grid grid-cols-3 gap-3.5">
            {SOURCES.map((s) => {
              const connected = !!sourceStatuses[s.key];
              return (
                <Card
                  key={s.key}
                  className="hover:border-emerald-500/30 transition-colors"
                >
                  <CardContent className="pt-4 pb-4 flex items-center gap-3.5">
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center text-lg shrink-0 ${s.color}`}
                    >
                      {s.key === "YOUTUBE" && <Youtube className="h-5 w-5" />}
                      {s.key === "TELEGRAM" && <Send className="h-5 w-5" />}
                      {s.key === "INSTAGRAM" && (
                        <Instagram className="h-5 w-5" />
                      )}
                      {s.key === "FACEBOOK" && <Facebook className="h-5 w-5" />}
                      {s.key === "LINKEDIN" && <Linkedin className="h-5 w-5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{s.name}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {s.desc}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        connected
                          ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                          : "bg-muted text-muted-foreground text-[10px]"
                      }
                    >
                      {connected ? "Подключён" : "Не настроен"}
                    </Badge>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        {/* Tasks */}
        <TabsContent value="tasks">
          <div className="flex items-center justify-between mb-3.5">
            <div className="text-sm text-muted-foreground">
              {tasks?.length ?? 0} задач
            </div>
            <Button
              size="sm"
              onClick={() => setShowNewTask(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Новая задача
            </Button>
          </div>

          {tasksLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : tasks?.length > 0 ? (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/30">
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Название
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Источник
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Ключевики
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Расписание
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Посл. запуск
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Статус
                    </th>
                    <th className="p-2.5 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task: any) => (
                    <tr
                      key={task.id}
                      className="border-t hover:bg-muted/20 transition-colors"
                    >
                      <td className="p-2.5 font-semibold">{task.name}</td>
                      <td className="p-2.5">
                        <SourceBadge source={task.source} />
                      </td>
                      <td className="p-2.5 text-muted-foreground max-w-[200px] truncate">
                        {task.keywords}
                      </td>
                      <td className="p-2.5 text-muted-foreground">
                        {task.schedule || "—"}
                      </td>
                      <td className="p-2.5 text-muted-foreground">
                        {task.lastRunAt
                          ? formatDistanceToNow(new Date(task.lastRunAt), {
                              locale: ru,
                              addSuffix: true,
                            })
                          : "—"}
                      </td>
                      <td className="p-2.5">
                        <Badge
                          variant="outline"
                          className={
                            task.status === "COMPLETED"
                              ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                              : task.status === "RUNNING"
                                ? "bg-blue-500/10 text-blue-500 text-[10px]"
                                : task.status === "QUEUED"
                                  ? "bg-yellow-500/10 text-yellow-500 text-[10px]"
                                  : task.status === "FAILED"
                                    ? "bg-red-500/10 text-red-500 text-[10px]"
                                    : "bg-muted text-muted-foreground text-[10px]"
                          }
                        >
                          {task.status === "COMPLETED"
                            ? "Завершён"
                            : task.status === "RUNNING"
                              ? "Работает"
                              : task.status === "QUEUED"
                                ? "В очереди"
                                : task.status === "FAILED"
                                  ? "Ошибка"
                                  : task.status}
                        </Badge>
                      </td>
                      <td className="p-2.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={runTaskMutation.isPending}
                          onClick={() => runTaskMutation.mutate(task.id)}
                        >
                          <Play className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={Search}
              title="Нет задач"
              description="Создайте первую задачу парсинга для автоматического сбора лидов"
              action={
                <Button
                  size="sm"
                  onClick={() => setShowNewTask(true)}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Создать задачу
                </Button>
              }
            />
          )}

          {/* New Task Dialog */}
          <Dialog open={showNewTask} onOpenChange={setShowNewTask}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Новая задача парсинга</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3 mt-2">
                <div className="col-span-2">
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Название
                  </label>
                  <Input
                    value={newTaskForm.name}
                    onChange={(e) =>
                      setNewTaskForm((p) => ({ ...p, name: e.target.value }))
                    }
                    placeholder="Фитнес-блогеры YouTube RU 100K+"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Источник
                  </label>
                  <Select
                    value={newTaskForm.source}
                    onValueChange={(v) =>
                      setNewTaskForm((p) => ({ ...p, source: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCES.map((s) => (
                        <SelectItem key={s.key} value={s.key}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Страна
                  </label>
                  <Select
                    value={newTaskForm.country}
                    onValueChange={(v) =>
                      setNewTaskForm((p) => ({ ...p, country: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Любая</SelectItem>
                      <SelectItem value="RU">Россия</SelectItem>
                      <SelectItem value="US">США</SelectItem>
                      <SelectItem value="UK">Великобритания</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Ключевые слова
                  </label>
                  <Input
                    value={newTaskForm.keywords}
                    onChange={(e) =>
                      setNewTaskForm((p) => ({
                        ...p,
                        keywords: e.target.value,
                      }))
                    }
                    placeholder="фитнес, тренировки, зож"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Мин. подписчиков
                  </label>
                  <Input
                    type="number"
                    value={newTaskForm.minSubscribers}
                    onChange={(e) =>
                      setNewTaskForm((p) => ({
                        ...p,
                        minSubscribers: parseInt(e.target.value) || 0,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Макс. результатов
                  </label>
                  <Input
                    type="number"
                    value={newTaskForm.maxResults}
                    onChange={(e) =>
                      setNewTaskForm((p) => ({
                        ...p,
                        maxResults: parseInt(e.target.value) || 50,
                      }))
                    }
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Расписание (cron или текст)
                  </label>
                  <Input
                    value={newTaskForm.schedule}
                    onChange={(e) =>
                      setNewTaskForm((p) => ({
                        ...p,
                        schedule: e.target.value,
                      }))
                    }
                    placeholder="Каждый день 09:00"
                  />
                </div>
                <div className="col-span-2 flex gap-2 mt-2">
                  <Button
                    onClick={() => createTaskMutation.mutate(newTaskForm)}
                    disabled={createTaskMutation.isPending || !newTaskForm.name}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {createTaskMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    )}
                    Создать
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowNewTask(false)}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* Runs */}
        <TabsContent value="runs">
          {runsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          ) : runs?.length > 0 ? (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/30">
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Дата
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Задача
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Источник
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Найдено
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Новых
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Стоимость
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Время
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Статус
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run: any) => (
                    <tr
                      key={run.id}
                      className="border-t hover:bg-muted/20 transition-colors"
                    >
                      <td className="p-2.5 text-muted-foreground whitespace-nowrap">
                        {run.createdAt
                          ? new Date(run.createdAt).toLocaleString("ru-RU", {
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                      </td>
                      <td className="p-2.5 font-medium">
                        {run.taskName ?? run.task?.name ?? "Быстрый запуск"}
                      </td>
                      <td className="p-2.5">
                        <SourceBadge source={run.source} />
                      </td>
                      <td className="p-2.5">{run.found ?? 0}</td>
                      <td className="p-2.5">{run.newLeads ?? 0}</td>
                      <td className="p-2.5">${(run.cost ?? 0).toFixed(2)}</td>
                      <td className="p-2.5 text-muted-foreground">
                        {run.duration ?? "—"}
                      </td>
                      <td className="p-2.5">
                        <Badge
                          variant="outline"
                          className={
                            run.status === "OK" || run.status === "COMPLETED"
                              ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                              : run.status === "RUNNING"
                                ? "bg-blue-500/10 text-blue-500 text-[10px]"
                                : run.status === "FAILED"
                                  ? "bg-red-500/10 text-red-500 text-[10px]"
                                  : "bg-muted text-muted-foreground text-[10px]"
                          }
                        >
                          {run.status === "OK" || run.status === "COMPLETED"
                            ? "OK"
                            : run.status === "FAILED"
                              ? "Ошибка"
                              : run.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={Clock}
              title="Нет запусков"
              description="История появится после первого запуска парсера"
            />
          )}
        </TabsContent>

        {/* Quick Run */}
        <TabsContent value="quick">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">
                Быстрый запуск
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Одноразовый парсинг без сохранения пресета. Вставьте URL или
                ключевые слова.
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Источник
                  </label>
                  <Select
                    value={quickForm.source}
                    onValueChange={(v) =>
                      setQuickForm((p) => ({ ...p, source: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOURCES.map((s) => (
                        <SelectItem key={s.key} value={s.key}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Запрос
                  </label>
                  <Input
                    value={quickForm.query}
                    onChange={(e) =>
                      setQuickForm((p) => ({ ...p, query: e.target.value }))
                    }
                    placeholder="URL канала или ключевые слова..."
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Мин. подписчиков
                  </label>
                  <Input
                    type="number"
                    value={quickForm.minSubs}
                    onChange={(e) =>
                      setQuickForm((p) => ({
                        ...p,
                        minSubs: parseInt(e.target.value) || 0,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Макс. результатов
                  </label>
                  <Input
                    type="number"
                    value={quickForm.maxResults}
                    onChange={(e) =>
                      setQuickForm((p) => ({
                        ...p,
                        maxResults: parseInt(e.target.value) || 50,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Страна
                  </label>
                  <Select
                    value={quickForm.country}
                    onValueChange={(v) =>
                      setQuickForm((p) => ({ ...p, country: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Любая</SelectItem>
                      <SelectItem value="RU">Россия</SelectItem>
                      <SelectItem value="US">США</SelectItem>
                      <SelectItem value="UK">Великобритания</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Мин. Engagement Rate
                  </label>
                  <Input
                    type="number"
                    step="0.5"
                    value={quickForm.minEngagement}
                    onChange={(e) =>
                      setQuickForm((p) => ({
                        ...p,
                        minEngagement: parseFloat(e.target.value) || 0,
                      }))
                    }
                  />
                </div>
                <div className="col-span-2 flex gap-2 mt-2">
                  <Button
                    onClick={() => quickRunMutation.mutate(quickForm)}
                    disabled={quickRunMutation.isPending || !quickForm.query}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {quickRunMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Search className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Запустить парсинг
                  </Button>
                  <Button variant="outline" disabled>
                    Сохранить как задачу
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Leads
// ═══════════════════════════════════════════════════════════════

function LeadsSection({ workspaceId }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [scoreFilter, setScoreFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [showNewSegment, setShowNewSegment] = useState(false);
  const [segmentForm, setSegmentForm] = useState({ name: "", filterJson: "" });

  const leadsQuery = useQuery({
    queryKey: [
      "mkt-leads",
      workspaceId,
      search,
      sourceFilter,
      statusFilter,
      scoreFilter,
      page,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (sourceFilter) params.set("source", sourceFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (scoreFilter) params.set("scoreLevel", scoreFilter);
      params.set("page", String(page));
      params.set("limit", "20");
      return fetchApi(api(workspaceId, `/leads?${params}`));
    },
  });

  const leadDetailQuery = useQuery({
    queryKey: ["mkt-lead-detail", workspaceId, selectedLeadId],
    queryFn: () => fetchApi(api(workspaceId, `/leads/${selectedLeadId}`)),
    enabled: !!selectedLeadId,
  });

  const segmentsQuery = useQuery({
    queryKey: ["mkt-segments", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/segments")),
  });

  const enrichMutation = useMutation({
    mutationFn: (leadId: string) =>
      postApi(api(workspaceId, `/leads/${leadId}/enrich`)),
    onSuccess: () => {
      toastSuccess("Лид обогащён");
      queryClient.invalidateQueries({ queryKey: ["mkt-leads", workspaceId] });
      queryClient.invalidateQueries({
        queryKey: ["mkt-lead-detail", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const updateLeadMutation = useMutation({
    mutationFn: ({ leadId, data }: { leadId: string; data: any }) =>
      patchApi(api(workspaceId, `/leads/${leadId}`), data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mkt-leads", workspaceId] });
      queryClient.invalidateQueries({
        queryKey: ["mkt-lead-detail", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const createSegmentMutation = useMutation({
    mutationFn: (data: typeof segmentForm) =>
      postApi(api(workspaceId, "/segments"), data),
    onSuccess: () => {
      toastSuccess("Сегмент создан");
      setShowNewSegment(false);
      setSegmentForm({ name: "", filterJson: "" });
      queryClient.invalidateQueries({
        queryKey: ["mkt-segments", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const leads = leadsQuery.data?.items ?? leadsQuery.data ?? [];
  const totalPages = leadsQuery.data?.totalPages ?? 1;
  const lead = leadDetailQuery.data;

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === leads.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(leads.map((l: any) => l.id)));
  }

  return (
    <div>
      <Tabs defaultValue="all" value={selectedLeadId ? "detail" : undefined}>
        <TabsList className="mb-4">
          <TabsTrigger value="all" onClick={() => setSelectedLeadId(null)}>
            Все лиды
          </TabsTrigger>
          <TabsTrigger value="detail" disabled={!selectedLeadId}>
            Карточка
          </TabsTrigger>
          <TabsTrigger value="segments">Сегменты</TabsTrigger>
          <TabsTrigger value="dupes">Дубликаты</TabsTrigger>
        </TabsList>

        {/* All Leads */}
        <TabsContent value="all">
          {/* Search bar */}
          <div className="flex gap-2 items-center flex-wrap p-3 bg-muted/20 border rounded-xl mb-3.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Поиск по имени / нику..."
                className="pl-8 h-8 text-xs w-52"
              />
            </div>
            <Select
              value={sourceFilter}
              onValueChange={(v) => {
                setSourceFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue placeholder="Все источники" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Все источники</SelectItem>
                {SOURCES.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-32">
                <SelectValue placeholder="Все статусы" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Все статусы</SelectItem>
                <SelectItem value="new">new</SelectItem>
                <SelectItem value="enriched">enriched</SelectItem>
                <SelectItem value="qualified">qualified</SelectItem>
                <SelectItem value="contacted">contacted</SelectItem>
                <SelectItem value="rejected">rejected</SelectItem>
                <SelectItem value="converted">converted</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={scoreFilter}
              onValueChange={(v) => {
                setScoreFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-32">
                <SelectValue placeholder="AI-скоринг" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">AI-скоринг</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-8 text-xs">
              <Download className="h-3 w-3 mr-1" />
              Экспорт CSV
            </Button>
          </div>

          {/* Bulk actions */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 mb-3 p-2.5 bg-emerald-500/5 border border-emerald-500/20 rounded-lg text-xs">
              <span className="font-medium">Выбрано: {selectedIds.size}</span>
              <div className="flex-1" />
              <Button size="sm" variant="outline" className="h-7 text-xs">
                <Send className="h-3 w-3 mr-1" /> В кампанию
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-red-500 hover:text-red-400"
              >
                <Trash2 className="h-3 w-3 mr-1" /> Отклонить
              </Button>
            </div>
          )}

          {leadsQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          ) : leads.length > 0 ? (
            <>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/30">
                      <th className="p-2.5 w-8">
                        <input
                          type="checkbox"
                          checked={
                            selectedIds.size === leads.length &&
                            leads.length > 0
                          }
                          onChange={toggleAll}
                          className="rounded"
                        />
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        Канал
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        Источник
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        Подписчики
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        Avg Views
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        ER
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        Контакты
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        AI Score
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        Статус
                      </th>
                      <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                        Дата
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead: any) => (
                      <tr
                        key={lead.id}
                        className="border-t hover:bg-muted/20 transition-colors"
                      >
                        <td className="p-2.5">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(lead.id)}
                            onChange={() => toggleSelect(lead.id)}
                            className="rounded"
                          />
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-muted shrink-0 flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                              {(lead.channelName ||
                                lead.name ||
                                "?")[0]?.toUpperCase()}
                            </div>
                            <div>
                              <button
                                className="text-emerald-500 hover:underline font-medium text-left"
                                onClick={() => setSelectedLeadId(lead.id)}
                              >
                                {lead.channelName || lead.name}
                              </button>
                              {lead.username && (
                                <div className="text-[10px] text-muted-foreground">
                                  @{lead.username}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="p-2.5">
                          <SourceBadge source={lead.source} />
                        </td>
                        <td className="p-2.5">
                          {formatNumber(lead.subscribers)}
                        </td>
                        <td className="p-2.5">
                          {lead.avgViews ? formatNumber(lead.avgViews) : "—"}
                        </td>
                        <td className="p-2.5">
                          {lead.engagementRate
                            ? `${lead.engagementRate}%`
                            : "—"}
                        </td>
                        <td className="p-2.5">
                          <div className="flex gap-1">
                            {lead.email && (
                              <Badge
                                variant="outline"
                                className="bg-emerald-500/10 text-emerald-500 text-[9px] px-1.5 py-0"
                              >
                                <Mail className="h-2.5 w-2.5" />
                              </Badge>
                            )}
                            {lead.telegramUsername && (
                              <Badge
                                variant="outline"
                                className="bg-blue-500/10 text-blue-500 text-[9px] px-1.5 py-0"
                              >
                                TG
                              </Badge>
                            )}
                            {lead.instagramUsername && (
                              <Badge
                                variant="outline"
                                className="bg-purple-500/10 text-purple-500 text-[9px] px-1.5 py-0"
                              >
                                IG
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="p-2.5">
                          <ScoreBadge score={lead.aiScore} />
                        </td>
                        <td className="p-2.5">
                          <StatusBadge status={lead.status} />
                        </td>
                        <td className="p-2.5 text-muted-foreground whitespace-nowrap">
                          {lead.createdAt
                            ? new Date(lead.createdAt).toLocaleDateString(
                                "ru-RU",
                                { day: "2-digit", month: "2-digit" },
                              )
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-center gap-2 mt-3.5 text-xs">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-3 w-3 mr-0.5" />
                  Назад
                </Button>
                <span className="text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Вперёд
                  <ChevronRight className="h-3 w-3 ml-0.5" />
                </Button>
              </div>
            </>
          ) : (
            <EmptyState
              icon={Users}
              title="Нет лидов"
              description="Запустите парсер или импортируйте лидов для начала работы"
            />
          )}
        </TabsContent>

        {/* Lead Detail */}
        <TabsContent value="detail">
          {!selectedLeadId ? (
            <EmptyState
              icon={Eye}
              title="Выберите лид"
              description="Кликните на имя лида в таблице для просмотра карточки"
            />
          ) : leadDetailQuery.isLoading ? (
            <div className="grid grid-cols-[1fr_340px] gap-4">
              <div className="space-y-3">
                <Skeleton className="h-32 rounded-xl" />
                <Skeleton className="h-24 rounded-xl" />
                <Skeleton className="h-40 rounded-xl" />
              </div>
              <div className="space-y-3">
                <Skeleton className="h-32 rounded-xl" />
                <Skeleton className="h-24 rounded-xl" />
              </div>
            </div>
          ) : lead ? (
            <div className="grid grid-cols-[1fr_340px] gap-4">
              {/* Left */}
              <div className="space-y-3.5">
                {/* Header */}
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-3.5">
                      <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center text-lg font-bold text-muted-foreground shrink-0">
                        {(lead.channelName ||
                          lead.name ||
                          "?")[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1">
                        <div className="text-lg font-bold">
                          {lead.channelName || lead.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {lead.username && `@${lead.username} · `}
                          {lead.source} · {lead.country || "—"}
                        </div>
                        <div className="flex gap-4 mt-2">
                          <div className="text-center">
                            <div className="text-base font-bold">
                              {formatNumber(lead.subscribers)}
                            </div>
                            <div className="text-[9px] uppercase text-muted-foreground">
                              Подписчики
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-base font-bold">
                              {lead.avgViews
                                ? formatNumber(lead.avgViews)
                                : "—"}
                            </div>
                            <div className="text-[9px] uppercase text-muted-foreground">
                              Avg Views
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-base font-bold">
                              {lead.engagementRate
                                ? `${lead.engagementRate}%`
                                : "—"}
                            </div>
                            <div className="text-[9px] uppercase text-muted-foreground">
                              ER
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <Button
                          size="sm"
                          className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-7"
                        >
                          <Plus className="h-3 w-3 mr-1" /> В кампанию
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-blue-500 text-xs h-7"
                          disabled={enrichMutation.isPending}
                          onClick={() => enrichMutation.mutate(lead.id)}
                        >
                          {enrichMutation.isPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Zap className="h-3 w-3 mr-1" />
                          )}
                          Обогатить
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-500 text-xs h-7"
                          onClick={() =>
                            updateLeadMutation.mutate({
                              leadId: lead.id,
                              data: { status: "rejected" },
                            })
                          }
                        >
                          <X className="h-3 w-3 mr-1" /> Отклонить
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* AI Summary */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      AI Резюме
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-sm leading-relaxed text-muted-foreground">
                      {lead.aiSummary ||
                        'AI-скоринг ещё не выполнен. Нажмите "Обогатить" для запуска анализа.'}
                    </div>
                  </CardContent>
                </Card>

                {/* History */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      История взаимодействий
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {lead.history?.length > 0 ? (
                      <div className="space-y-1.5">
                        {lead.history.map((h: any, i: number) => (
                          <div
                            key={i}
                            className="flex gap-3 p-2.5 rounded-lg bg-muted/30 border text-xs"
                          >
                            <div
                              className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                                h.type === "created"
                                  ? "bg-emerald-500/10 text-emerald-500"
                                  : h.type === "enriched"
                                    ? "bg-blue-500/10 text-blue-500"
                                    : h.type === "scored"
                                      ? "bg-purple-500/10 text-purple-500"
                                      : h.type === "contacted"
                                        ? "bg-orange-500/10 text-orange-500"
                                        : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {h.type === "created" && (
                                <Plus className="h-3 w-3" />
                              )}
                              {h.type === "enriched" && (
                                <Zap className="h-3 w-3" />
                              )}
                              {h.type === "scored" && (
                                <Target className="h-3 w-3" />
                              )}
                              {h.type === "contacted" && (
                                <Mail className="h-3 w-3" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-medium">{h.title}</div>
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {h.createdAt
                                  ? formatDistanceToNow(new Date(h.createdAt), {
                                      locale: ru,
                                      addSuffix: true,
                                    })
                                  : h.meta}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground text-center py-6">
                        Нет событий
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Right sidebar */}
              <div className="space-y-3.5">
                {/* Contacts */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Контакты
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-xs">
                      {lead.email && (
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="bg-emerald-500/10 text-emerald-500 text-[9px] w-6 justify-center"
                          >
                            <Mail className="h-2.5 w-2.5" />
                          </Badge>
                          <span className="truncate">{lead.email}</span>
                          {lead.emailType && (
                            <Badge
                              variant="outline"
                              className="bg-emerald-500/10 text-emerald-500 text-[9px] ml-auto shrink-0"
                            >
                              {lead.emailType}
                            </Badge>
                          )}
                        </div>
                      )}
                      {lead.telegramUsername && (
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="bg-blue-500/10 text-blue-500 text-[9px] w-6 justify-center"
                          >
                            TG
                          </Badge>
                          <span>@{lead.telegramUsername}</span>
                        </div>
                      )}
                      {lead.instagramUsername && (
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="bg-purple-500/10 text-purple-500 text-[9px] w-6 justify-center"
                          >
                            IG
                          </Badge>
                          <span>@{lead.instagramUsername}</span>
                        </div>
                      )}
                      {lead.website && (
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="bg-muted text-muted-foreground text-[9px] w-6 justify-center"
                          >
                            <ExternalLink className="h-2.5 w-2.5" />
                          </Badge>
                          <span className="truncate">{lead.website}</span>
                        </div>
                      )}
                      {!lead.email &&
                        !lead.telegramUsername &&
                        !lead.instagramUsername &&
                        !lead.website && (
                          <div className="text-muted-foreground text-center py-3">
                            Контакты не найдены
                          </div>
                        )}
                    </div>
                  </CardContent>
                </Card>

                {/* Status */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Статус
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">
                          Lead status
                        </span>
                        <StatusBadge status={lead.status} />
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">AI Score</span>
                        <ScoreBadge score={lead.aiScore} />
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Диалог</span>
                        <Badge
                          variant="outline"
                          className="bg-muted text-muted-foreground text-[10px]"
                        >
                          {lead.dialogueStatus || "not_contacted"}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Projects */}
                {lead.projects?.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Привязка к проектам
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-1.5">
                        {lead.projects.map((p: any) => (
                          <div
                            key={p.id}
                            className="flex items-center gap-2 text-xs p-1.5 bg-muted/30 rounded-md"
                          >
                            <span
                              className="w-2 h-2 rounded-sm shrink-0"
                              style={{
                                background: p.color || "var(--emerald-500)",
                              }}
                            />
                            {p.name}
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Notes */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                      Заметки
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <textarea
                      className="w-full min-h-[80px] bg-muted/30 border rounded-lg p-2.5 text-xs resize-y focus:border-emerald-500 focus:outline-none"
                      placeholder="Добавить заметку..."
                      defaultValue={lead.notes || ""}
                      onBlur={(e) => {
                        if (e.target.value !== (lead.notes || "")) {
                          updateLeadMutation.mutate({
                            leadId: lead.id,
                            data: { notes: e.target.value },
                          });
                        }
                      }}
                    />
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={AlertCircle}
              title="Лид не найден"
              description="Попробуйте выбрать другой лид из списка"
            />
          )}
        </TabsContent>

        {/* Segments */}
        <TabsContent value="segments">
          <div className="flex items-center justify-between mb-3.5">
            <div className="text-sm text-muted-foreground">
              Сохранённые сегменты
            </div>
            <Button
              size="sm"
              onClick={() => setShowNewSegment(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Новый сегмент
            </Button>
          </div>

          {segmentsQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : segmentsQuery.data?.length > 0 ? (
            <div className="space-y-2.5">
              {segmentsQuery.data.map((seg: any) => (
                <Card
                  key={seg.id}
                  className="hover:border-emerald-500/30 transition-colors"
                >
                  <CardContent className="pt-4 pb-4 flex items-center gap-3.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{seg.name}</div>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {seg.description || seg.filterJson || "Без описания"}
                      </div>
                    </div>
                    <div className="text-sm font-bold shrink-0">
                      {seg.leadCount ?? 0} лидов
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs h-7 shrink-0"
                    >
                      Открыть
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Filter}
              title="Нет сегментов"
              description="Создайте сегмент для группировки лидов по критериям"
              action={
                <Button
                  size="sm"
                  onClick={() => setShowNewSegment(true)}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Создать сегмент
                </Button>
              }
            />
          )}

          <Dialog open={showNewSegment} onOpenChange={setShowNewSegment}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Новый сегмент</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 mt-2">
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Название
                  </label>
                  <Input
                    value={segmentForm.name}
                    onChange={(e) =>
                      setSegmentForm((p) => ({ ...p, name: e.target.value }))
                    }
                    placeholder="IG-блогеры фитнес 50K-200K RU с email"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Описание фильтров
                  </label>
                  <Input
                    value={segmentForm.filterJson}
                    onChange={(e) =>
                      setSegmentForm((p) => ({
                        ...p,
                        filterJson: e.target.value,
                      }))
                    }
                    placeholder="Instagram · 50K-200K подписчиков · Россия · Есть email"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => createSegmentMutation.mutate(segmentForm)}
                    disabled={
                      createSegmentMutation.isPending || !segmentForm.name
                    }
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {createSegmentMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    )}
                    Создать
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowNewSegment(false)}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* Duplicates */}
        <TabsContent value="dupes">
          <EmptyState
            icon={Users}
            title="Дубликаты"
            description="Система автоматически найдёт потенциальные дубликаты после накопления лидов"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Campaigns
// ═══════════════════════════════════════════════════════════════

function CampaignsSection({ workspaceId }: Props) {
  const queryClient = useQueryClient();
  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [templateForm, setTemplateForm] = useState({
    name: "",
    channel: "EMAIL",
    language: "RU",
    body: "",
  });
  const [selectedDialogueId, setSelectedDialogueId] = useState<string | null>(
    null,
  );

  const projectsQuery = useQuery({
    queryKey: ["mkt-projects", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/projects")),
  });

  const templatesQuery = useQuery({
    queryKey: ["mkt-templates", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/templates")),
  });

  const dialoguesQuery = useQuery({
    queryKey: ["mkt-dialogues", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/dialogues")),
  });

  const messagesQuery = useQuery({
    queryKey: ["mkt-messages", workspaceId, selectedDialogueId],
    queryFn: () =>
      fetchApi(api(workspaceId, `/dialogues/${selectedDialogueId}`)),
    enabled: !!selectedDialogueId,
  });

  const pendingQuery = useQuery({
    queryKey: ["mkt-pending", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/pending")),
  });

  const createTemplateMutation = useMutation({
    mutationFn: (data: typeof templateForm) =>
      postApi(api(workspaceId, "/templates"), data),
    onSuccess: () => {
      toastSuccess("Шаблон создан");
      setShowNewTemplate(false);
      setTemplateForm({ name: "", channel: "EMAIL", language: "RU", body: "" });
      queryClient.invalidateQueries({
        queryKey: ["mkt-templates", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) =>
      postApi(api(workspaceId, `/pending/${id}/approve`)),
    onSuccess: () => {
      toastSuccess("Сообщение одобрено");
      queryClient.invalidateQueries({ queryKey: ["mkt-pending", workspaceId] });
      queryClient.invalidateQueries({
        queryKey: ["mkt-dialogues", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const rejectPendingMutation = useMutation({
    mutationFn: (id: string) =>
      postApi(api(workspaceId, `/pending/${id}/reject`)),
    onSuccess: () => {
      toastSuccess("Сообщение отклонено");
      queryClient.invalidateQueries({ queryKey: ["mkt-pending", workspaceId] });
    },
    onError: toastApiError,
  });

  const STAT_LABELS = [
    { key: "sent", label: "Отправлено", color: "" },
    { key: "opened", label: "Открыто", color: "text-blue-500" },
    { key: "replied", label: "Ответили", color: "text-emerald-500" },
    { key: "interested", label: "Интересно", color: "text-yellow-500" },
    { key: "rejected", label: "Отказ", color: "text-red-500" },
  ];

  const dialogues = dialoguesQuery.data ?? [];
  const messages = messagesQuery.data?.messages ?? messagesQuery.data ?? [];
  const pending = pendingQuery.data ?? [];

  return (
    <div>
      <Tabs defaultValue="campaigns">
        <TabsList className="mb-4">
          <TabsTrigger value="campaigns">Кампании</TabsTrigger>
          <TabsTrigger value="templates">Шаблоны</TabsTrigger>
          <TabsTrigger value="inbox">
            Входящие
            {dialogues.length > 0 && (
              <Badge
                variant="destructive"
                className="ml-1.5 text-[9px] px-1.5 py-0 h-4"
              >
                {dialogues.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="approvals">
            Одобрение
            {pending.length > 0 && (
              <Badge className="ml-1.5 text-[9px] px-1.5 py-0 h-4 bg-yellow-500 text-black">
                {pending.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Campaigns */}
        <TabsContent value="campaigns">
          <div className="flex items-center justify-between mb-3.5">
            <div className="text-sm text-muted-foreground">
              {projectsQuery.data?.length ?? 0} кампаний
            </div>
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Новая кампания
            </Button>
          </div>

          {projectsQuery.isLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-40 rounded-xl" />
              ))}
            </div>
          ) : projectsQuery.data?.length > 0 ? (
            <div className="space-y-3">
              {projectsQuery.data.map((project: any) => (
                <Card
                  key={project.id}
                  className="hover:border-emerald-500/30 transition-colors"
                >
                  <CardContent className="pt-4 pb-4">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <div className="text-base font-bold">
                          {project.name}
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-1">
                          {project.segmentName &&
                            `Сегмент: ${project.segmentName} · `}
                          Каналы: {project.channels || "Email"}
                        </div>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          project.status === "ACTIVE"
                            ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                            : project.status === "DRAFT"
                              ? "bg-yellow-500/10 text-yellow-500 text-[10px]"
                              : project.status === "PAUSED"
                                ? "bg-orange-500/10 text-orange-500 text-[10px]"
                                : "bg-muted text-muted-foreground text-[10px]"
                        }
                      >
                        {project.status === "ACTIVE"
                          ? "Активна"
                          : project.status === "DRAFT"
                            ? "Черновик"
                            : project.status === "PAUSED"
                              ? "Пауза"
                              : project.status}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-5 gap-2.5">
                      {STAT_LABELS.map((s) => (
                        <div
                          key={s.key}
                          className="text-center p-2.5 bg-muted/20 rounded-lg"
                        >
                          <div
                            className={`text-xl font-extrabold ${s.color || (project.stats?.[s.key] ? "" : "text-muted-foreground")}`}
                          >
                            {project.stats?.[s.key] ?? 0}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {s.label}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Megaphone}
              title="Нет кампаний"
              description="Создайте кампанию для автоматизированного outreach"
            />
          )}
        </TabsContent>

        {/* Templates */}
        <TabsContent value="templates">
          <div className="flex items-center justify-between mb-3.5">
            <div className="text-sm text-muted-foreground">
              Шаблоны сообщений
            </div>
            <Button
              size="sm"
              onClick={() => setShowNewTemplate(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Новый шаблон
            </Button>
          </div>

          {templatesQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          ) : templatesQuery.data?.length > 0 ? (
            <div className="space-y-2.5">
              {templatesQuery.data.map((tpl: any) => (
                <Card
                  key={tpl.id}
                  className="hover:border-emerald-500/30 transition-colors"
                >
                  <CardContent className="pt-4 pb-4">
                    <div className="flex justify-between items-center mb-2">
                      <div className="text-sm font-semibold">{tpl.name}</div>
                      <div className="flex gap-1.5">
                        <Badge
                          variant="outline"
                          className={
                            tpl.channel === "EMAIL"
                              ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                              : tpl.channel === "TELEGRAM"
                                ? "bg-blue-500/10 text-blue-500 text-[10px]"
                                : "bg-muted text-muted-foreground text-[10px]"
                          }
                        >
                          {tpl.channel}
                        </Badge>
                        {tpl.language && (
                          <Badge
                            variant="outline"
                            className="bg-blue-500/10 text-blue-500 text-[10px]"
                          >
                            {tpl.language}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg leading-relaxed whitespace-pre-wrap">
                      {tpl.body}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={MessageSquare}
              title="Нет шаблонов"
              description="Создайте шаблон сообщения для автоматических рассылок"
              action={
                <Button
                  size="sm"
                  onClick={() => setShowNewTemplate(true)}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Создать шаблон
                </Button>
              }
            />
          )}

          <Dialog open={showNewTemplate} onOpenChange={setShowNewTemplate}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Новый шаблон</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 mt-2">
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Название
                  </label>
                  <Input
                    value={templateForm.name}
                    onChange={(e) =>
                      setTemplateForm((p) => ({ ...p, name: e.target.value }))
                    }
                    placeholder="Холодный email — Рекламное предложение"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                      Канал
                    </label>
                    <Select
                      value={templateForm.channel}
                      onValueChange={(v) =>
                        setTemplateForm((p) => ({ ...p, channel: v }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="EMAIL">Email</SelectItem>
                        <SelectItem value="TELEGRAM">Telegram</SelectItem>
                        <SelectItem value="INSTAGRAM">Instagram DM</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                      Язык
                    </label>
                    <Select
                      value={templateForm.language}
                      onValueChange={(v) =>
                        setTemplateForm((p) => ({ ...p, language: v }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="RU">RU</SelectItem>
                        <SelectItem value="EN">EN</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Текст сообщения
                  </label>
                  <textarea
                    className="w-full min-h-[120px] bg-muted/30 border rounded-lg p-3 text-xs resize-y focus:border-emerald-500 focus:outline-none"
                    value={templateForm.body}
                    onChange={(e) =>
                      setTemplateForm((p) => ({ ...p, body: e.target.value }))
                    }
                    placeholder={
                      "Привет, {{name}}!\n\nЯ {{sender_name}} из {{company}}..."
                    }
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => createTemplateMutation.mutate(templateForm)}
                    disabled={
                      createTemplateMutation.isPending ||
                      !templateForm.name ||
                      !templateForm.body
                    }
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {createTemplateMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    )}
                    Создать
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowNewTemplate(false)}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* Inbox */}
        <TabsContent value="inbox">
          {dialoguesQuery.isLoading ? (
            <div className="grid grid-cols-[300px_1fr] gap-3.5 h-[calc(100vh-220px)]">
              <Skeleton className="rounded-xl" />
              <Skeleton className="rounded-xl" />
            </div>
          ) : dialogues.length > 0 ? (
            <div className="grid grid-cols-[300px_1fr] gap-3.5 h-[calc(100vh-220px)]">
              {/* Dialogue list */}
              <Card className="overflow-y-auto">
                <CardContent className="p-2">
                  {dialogues.map((d: any) => (
                    <button
                      key={d.id}
                      onClick={() => setSelectedDialogueId(d.id)}
                      className={`w-full text-left p-2.5 rounded-lg mb-0.5 transition-colors ${
                        selectedDialogueId === d.id
                          ? "bg-emerald-500/10"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <div className="text-sm font-semibold">
                        {d.leadName || d.lead?.channelName || "Unknown"}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {d.lastMessage || "Нет сообщений"}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1">
                        {d.updatedAt
                          ? formatDistanceToNow(new Date(d.updatedAt), {
                              locale: ru,
                              addSuffix: true,
                            })
                          : ""}{" "}
                        · {d.channel || "Email"}
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>

              {/* Chat */}
              <Card className="flex flex-col">
                {selectedDialogueId ? (
                  <>
                    <div className="p-3.5 border-b font-semibold text-sm">
                      {dialogues.find((d: any) => d.id === selectedDialogueId)
                        ?.leadName || "Диалог"}{" "}
                      ·{" "}
                      {dialogues.find((d: any) => d.id === selectedDialogueId)
                        ?.channel || "Email"}
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto space-y-2.5">
                      {messagesQuery.isLoading ? (
                        <div className="space-y-2">
                          {[1, 2, 3].map((i) => (
                            <Skeleton key={i} className="h-16 rounded-xl" />
                          ))}
                        </div>
                      ) : messages.length > 0 ? (
                        messages.map((msg: any, i: number) => (
                          <div
                            key={i}
                            className={`max-w-[70%] p-3 rounded-2xl text-sm leading-relaxed ${
                              msg.direction === "OUT"
                                ? msg.pending
                                  ? "bg-purple-500/10 ml-auto rounded-br-sm"
                                  : "bg-emerald-500/10 ml-auto rounded-br-sm"
                                : "bg-muted/50 rounded-bl-sm"
                            }`}
                          >
                            {msg.pending && (
                              <div className="text-[10px] text-purple-500 font-semibold mb-1">
                                AI предлагает ответ:
                              </div>
                            )}
                            <div className="whitespace-pre-wrap">
                              {msg.body}
                            </div>
                            <div className="text-[9px] text-muted-foreground mt-1">
                              {msg.sender ||
                                (msg.direction === "OUT" ? "AI Agent" : "Lead")}
                              {msg.createdAt &&
                                ` · ${new Date(msg.createdAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-muted-foreground text-center py-10">
                          Нет сообщений
                        </div>
                      )}
                    </div>
                    <div className="p-3 border-t flex gap-2">
                      <Button
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                      >
                        Одобрить ответ AI
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs">
                        Редактировать
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs text-red-500"
                      >
                        Ответить вручную
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-sm text-muted-foreground">
                      Выберите диалог
                    </div>
                  </div>
                )}
              </Card>
            </div>
          ) : (
            <EmptyState
              icon={MessageSquare}
              title="Нет диалогов"
              description="Входящие сообщения появятся после запуска кампании"
            />
          )}
        </TabsContent>

        {/* Approvals */}
        <TabsContent value="approvals">
          {pendingQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-32 rounded-xl" />
              ))}
            </div>
          ) : pending.length > 0 ? (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground mb-1">
                {pending.length} сообщений ожидают одобрения
              </div>
              {pending.map((item: any) => (
                <Card
                  key={item.id}
                  className="hover:border-emerald-500/30 transition-colors"
                >
                  <CardContent className="pt-4 pb-4">
                    <div className="flex justify-between items-center mb-2.5">
                      <div>
                        <div className="text-sm font-semibold">
                          {item.leadName || item.lead?.channelName}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {item.channel || "Email"} · Кампания:{" "}
                          {item.projectName || item.project?.name || "—"}
                        </div>
                      </div>
                      {item.tag && (
                        <Badge
                          variant="outline"
                          className={
                            item.tag === "price"
                              ? "bg-yellow-500/10 text-yellow-500 text-[10px]"
                              : item.tag === "first"
                                ? "bg-orange-500/10 text-orange-500 text-[10px]"
                                : "bg-muted text-muted-foreground text-[10px]"
                          }
                        >
                          {item.tag === "price"
                            ? "Цена упомянута"
                            : item.tag === "first"
                              ? "Первое сообщение"
                              : item.tag}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg mb-3 leading-relaxed whitespace-pre-wrap">
                      {item.messageBody || item.body}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                        disabled={approveMutation.isPending}
                        onClick={() => approveMutation.mutate(item.id)}
                      >
                        {approveMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <Check className="h-3 w-3 mr-1" />
                        )}
                        Одобрить
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs">
                        Редактировать
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs text-red-500"
                        disabled={rejectPendingMutation.isPending}
                        onClick={() => rejectPendingMutation.mutate(item.id)}
                      >
                        Отклонить
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Check}
              title="Все одобрено"
              description="Нет сообщений, ожидающих одобрения"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Analytics
// ═══════════════════════════════════════════════════════════════

function AnalyticsSection({ workspaceId }: Props) {
  const { data: analytics, isLoading } = useQuery({
    queryKey: ["mkt-analytics-full", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/analytics")),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-3.5">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const leadsBySource = analytics?.leadsBySource ?? [];
  const dailyCosts = analytics?.dailyCosts ?? [];
  const totalLeads = analytics?.totalLeads ?? 0;
  const qualifiedLeads = analytics?.qualifiedLeads ?? 0;
  const avgCostPerLead = analytics?.avgCostPerLead ?? 0;
  const bestSource = analytics?.bestSource ?? "—";

  return (
    <div>
      <Tabs defaultValue="sources">
        <TabsList className="mb-4">
          <TabsTrigger value="sources">По источникам</TabsTrigger>
          <TabsTrigger value="costs">Расходы</TabsTrigger>
        </TabsList>

        <TabsContent value="sources">
          {/* KPI */}
          <div className="grid grid-cols-4 gap-3.5 mb-4">
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Всего лидов
                </div>
                <div className="text-3xl font-extrabold">{totalLeads}</div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Qualified
                </div>
                <div className="text-3xl font-extrabold">{qualifiedLeads}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {totalLeads > 0
                    ? `${((qualifiedLeads / totalLeads) * 100).toFixed(1)}% от всех`
                    : "—"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Средняя стоимость лида
                </div>
                <div className="text-3xl font-extrabold">
                  $
                  {typeof avgCostPerLead === "number"
                    ? avgCostPerLead.toFixed(2)
                    : "0.00"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Лучший источник
                </div>
                <div className="text-lg font-extrabold">{bestSource}</div>
              </CardContent>
            </Card>
          </div>

          {/* Source table */}
          {leadsBySource.length > 0 ? (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/30">
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Источник
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Всего лидов
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      С email
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Qualified
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Contacted
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Ответили
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Конверсия
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Ср. стоимость
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {leadsBySource.map((src: any) => (
                    <tr
                      key={src.source}
                      className="border-t hover:bg-muted/20 transition-colors"
                    >
                      <td className="p-2.5">
                        <SourceBadge source={src.source} />
                      </td>
                      <td className="p-2.5">{src.total}</td>
                      <td className="p-2.5">
                        {src.withEmail ?? 0}
                        {src.total > 0 && (
                          <span className="text-muted-foreground ml-1">
                            (
                            {(((src.withEmail ?? 0) / src.total) * 100).toFixed(
                              0,
                            )}
                            %)
                          </span>
                        )}
                      </td>
                      <td className="p-2.5">{src.qualified ?? 0}</td>
                      <td className="p-2.5">{src.contacted ?? 0}</td>
                      <td className="p-2.5">{src.replied ?? 0}</td>
                      <td className="p-2.5 text-emerald-500 font-bold">
                        {src.conversionRate ?? 0}%
                      </td>
                      <td className="p-2.5">
                        ${(src.avgCost ?? 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={BarChart3}
              title="Нет данных"
              description="Аналитика появится после начала работы с лидами"
            />
          )}
        </TabsContent>

        <TabsContent value="costs">
          {/* Cost KPIs */}
          <div className="grid grid-cols-4 gap-3.5 mb-4">
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Всего за месяц
                </div>
                <div className="text-3xl font-extrabold">
                  ${analytics?.totalCost?.toFixed(2) ?? "0.00"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Apify
                </div>
                <div className="text-3xl font-extrabold">
                  ${analytics?.apifyCost?.toFixed(2) ?? "0.00"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  YouTube API
                </div>
                <div className="text-3xl font-extrabold">
                  ${analytics?.youtubeCost?.toFixed(2) ?? "0.00"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Claude API
                </div>
                <div className="text-3xl font-extrabold">
                  ${analytics?.claudeCost?.toFixed(2) ?? "0.00"}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Cost breakdown table */}
          {dailyCosts.length > 0 ? (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/30">
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Сервис
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Тип
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Сумма
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Единиц
                    </th>
                    <th className="text-left p-2.5 font-bold text-[10px] uppercase text-muted-foreground tracking-wide">
                      Дата
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dailyCosts.map((cost: any, i: number) => (
                    <tr
                      key={i}
                      className="border-t hover:bg-muted/20 transition-colors"
                    >
                      <td className="p-2.5 font-medium">{cost.service}</td>
                      <td className="p-2.5 text-muted-foreground">
                        {cost.type}
                      </td>
                      <td className="p-2.5">
                        ${(cost.amount ?? 0).toFixed(2)}
                      </td>
                      <td className="p-2.5 text-muted-foreground">
                        {cost.units ?? "—"}
                      </td>
                      <td className="p-2.5 text-muted-foreground">
                        {cost.date
                          ? new Date(cost.date).toLocaleDateString("ru-RU", {
                              day: "2-digit",
                              month: "2-digit",
                            })
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={DollarSign}
              title="Нет расходов"
              description="Расходы будут отображаться после использования API"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SECTION: Settings
// ═══════════════════════════════════════════════════════════════

function SettingsSection({ workspaceId }: Props) {
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ["mkt-config", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/config")),
  });

  const [form, setForm] = useState<Record<string, any>>({});
  const [initialized, setInitialized] = useState(false);

  // Initialize form from config
  if (config && !initialized) {
    setForm({
      youtubeApiKey: config.youtubeApiKey || "",
      anthropicApiKey: config.anthropicApiKey || "",
      apifyToken: config.apifyToken || "",
      telegramApiId: config.telegramApiId || "",
      telegramApiHash: config.telegramApiHash || "",
      resendApiKey: config.resendApiKey || "",
      imapHost: config.imapHost || "",
      imapUser: config.imapUser || "",
      scoringModel: config.scoringModel || "haiku",
      scoreHighThreshold: config.scoreHighThreshold ?? 0.75,
      scoreMediumThreshold: config.scoreMediumThreshold ?? 0.4,
      minSubsForScoring: config.minSubsForScoring ?? 5000,
      scoringPrompt: config.scoringPrompt || "",
      dedupByEmail: config.dedupByEmail ?? true,
      dedupByUsername: config.dedupByUsername ?? true,
      dedupByNameGeo: config.dedupByNameGeo ?? false,
      dailyApifyLimit: config.dailyApifyLimit ?? 5,
      monthlyApifyLimit: config.monthlyApifyLimit ?? 50,
      dailyClaudeLimit: config.dailyClaudeLimit ?? 3,
      monthlyClaudeLimit: config.monthlyClaudeLimit ?? 50,
      alertThreshold: config.alertThreshold ?? 80,
      maxEmailPerDay: config.maxEmailPerDay ?? 200,
      maxTgPerDay: config.maxTgPerDay ?? 30,
      messagePauseSeconds: config.messagePauseSeconds ?? 60,
    });
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      patchApi(api(workspaceId, "/config"), data),
    onSuccess: () => {
      toastSuccess("Настройки сохранены");
      queryClient.invalidateQueries({ queryKey: ["mkt-config", workspaceId] });
    },
    onError: toastApiError,
  });

  function _maskKey(key: string): string {
    if (!key) return "";
    if (key.length <= 8) return key.slice(0, 2) + "••••••";
    return key.slice(0, 6) + "••••••••";
  }

  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

  function toggleShowKey(field: string) {
    setShowKeys((p) => ({ ...p, [field]: !p[field] }));
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  return (
    <div>
      <Tabs defaultValue="integrations">
        <TabsList className="mb-4">
          <TabsTrigger value="integrations">Интеграции</TabsTrigger>
          <TabsTrigger value="scoring">AI-скоринг</TabsTrigger>
          <TabsTrigger value="dedup">Дедупликация</TabsTrigger>
          <TabsTrigger value="budgets">Бюджеты</TabsTrigger>
          <TabsTrigger value="team">Команда</TabsTrigger>
        </TabsList>

        {/* Integrations */}
        <TabsContent value="integrations">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">
                API ключи и интеграции
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                { label: "YouTube Data API Key", field: "youtubeApiKey" },
                { label: "Anthropic API Key", field: "anthropicApiKey" },
                { label: "Apify Token", field: "apifyToken" },
                { label: "Resend API Key", field: "resendApiKey" },
              ].map(({ label, field }) => (
                <div
                  key={field}
                  className="flex items-center gap-3 py-2 border-b border-border/30"
                >
                  <label className="flex-1 text-sm">{label}</label>
                  <Input
                    type={showKeys[field] ? "text" : "password"}
                    value={form[field] || ""}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, [field]: e.target.value }))
                    }
                    className="max-w-[300px] text-xs"
                    placeholder="Не настроен"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-8 w-16"
                    onClick={() => toggleShowKey(field)}
                  >
                    {showKeys[field] ? "Скрыть" : "Показать"}
                  </Button>
                  <Button variant="outline" size="sm" className="text-xs h-8">
                    Проверить
                  </Button>
                  <Badge
                    variant="outline"
                    className={
                      form[field]
                        ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                        : "bg-orange-500/10 text-orange-500 text-[10px]"
                    }
                  >
                    {form[field] ? "OK" : "Не настроен"}
                  </Badge>
                </div>
              ))}

              {/* Telegram */}
              <div className="flex items-center gap-3 py-2 border-b border-border/30">
                <label className="flex-1 text-sm">Telegram API ID / Hash</label>
                <Input
                  value={form.telegramApiId || ""}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, telegramApiId: e.target.value }))
                  }
                  className="max-w-[120px] text-xs"
                  placeholder="API ID"
                />
                <Input
                  type={showKeys.telegramApiHash ? "text" : "password"}
                  value={form.telegramApiHash || ""}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, telegramApiHash: e.target.value }))
                  }
                  className="max-w-[180px] text-xs"
                  placeholder="API Hash"
                />
                <Button variant="outline" size="sm" className="text-xs h-8">
                  Login
                </Button>
                <Badge
                  variant="outline"
                  className={
                    form.telegramApiId
                      ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                      : "bg-orange-500/10 text-orange-500 text-[10px]"
                  }
                >
                  {form.telegramApiId ? "Connected" : "Не настроен"}
                </Badge>
              </div>

              {/* IMAP */}
              <div className="flex items-center gap-3 py-2">
                <label className="flex-1 text-sm">IMAP (входящие)</label>
                <Input
                  value={form.imapHost || ""}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, imapHost: e.target.value }))
                  }
                  className="max-w-[160px] text-xs"
                  placeholder="imap.gmail.com"
                />
                <Input
                  value={form.imapUser || ""}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, imapUser: e.target.value }))
                  }
                  className="max-w-[180px] text-xs"
                  placeholder="user@gmail.com"
                />
                <Button variant="outline" size="sm" className="text-xs h-8">
                  Тест
                </Button>
                <Badge
                  variant="outline"
                  className={
                    form.imapHost
                      ? "bg-emerald-500/10 text-emerald-500 text-[10px]"
                      : "bg-orange-500/10 text-orange-500 text-[10px]"
                  }
                >
                  {form.imapHost ? "OK" : "Не настроен"}
                </Badge>
              </div>

              <div className="pt-3">
                <Button
                  onClick={() => saveMutation.mutate(form)}
                  disabled={saveMutation.isPending}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {saveMutation.isPending && (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  )}
                  Сохранить
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* AI Scoring */}
        <TabsContent value="scoring">
          <Card>
            <CardHeader>
              <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Правила AI-скоринга
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Модель для скоринга
                  </label>
                  <Select
                    value={form.scoringModel || "haiku"}
                    onValueChange={(v) =>
                      setForm((p) => ({ ...p, scoringModel: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="haiku">Claude Haiku 4.5</SelectItem>
                      <SelectItem value="sonnet">Claude Sonnet 4.6</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Порог High
                  </label>
                  <Input
                    type="number"
                    step="0.05"
                    value={form.scoreHighThreshold ?? 0.75}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        scoreHighThreshold: parseFloat(e.target.value),
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Порог Medium
                  </label>
                  <Input
                    type="number"
                    step="0.05"
                    value={form.scoreMediumThreshold ?? 0.4}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        scoreMediumThreshold: parseFloat(e.target.value),
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Мин. подписчиков для скоринга
                  </label>
                  <Input
                    type="number"
                    value={form.minSubsForScoring ?? 5000}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        minSubsForScoring: parseInt(e.target.value) || 0,
                      }))
                    }
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                    Промпт для скоринга
                  </label>
                  <textarea
                    className="w-full min-h-[120px] bg-muted/30 border rounded-lg p-3 text-xs resize-y focus:border-emerald-500 focus:outline-none"
                    value={form.scoringPrompt || ""}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, scoringPrompt: e.target.value }))
                    }
                    placeholder={
                      'Оцени этого блогера как потенциального рекламного партнёра. Учти: размер аудитории, вовлечённость, тематику, регион, наличие контактов. Верни JSON: { "score": 0.0-1.0, "summary": "...", "pros": [...], "cons": [...] }'
                    }
                  />
                </div>
                <div className="col-span-2 flex gap-2 mt-1">
                  <Button
                    onClick={() => saveMutation.mutate(form)}
                    disabled={saveMutation.isPending}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {saveMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    )}
                    Сохранить
                  </Button>
                  <Button variant="outline">Сбросить по умолчанию</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Dedup */}
        <TabsContent value="dedup">
          <Card>
            <CardHeader>
              <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Правила дедупликации
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {[
                {
                  field: "dedupByEmail",
                  label: "По email",
                  desc: "Один email = один человек",
                },
                {
                  field: "dedupByUsername",
                  label: "По username",
                  desc: "Одинаковый ник на разных платформах",
                },
                {
                  field: "dedupByNameGeo",
                  label: "По имени + гео",
                  desc: "Совпадение имени и страны (ниже точность)",
                },
              ].map(({ field, label, desc }) => (
                <div
                  key={field}
                  className="flex items-center gap-3 p-2.5 bg-muted/20 rounded-lg"
                >
                  <button
                    className={`w-10 h-[22px] rounded-full relative shrink-0 transition-colors ${
                      form[field] ? "bg-emerald-500" : "bg-muted-foreground/30"
                    }`}
                    onClick={() =>
                      setForm((p) => ({ ...p, [field]: !p[field] }))
                    }
                  >
                    <div
                      className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-transform ${
                        form[field] ? "left-[22px]" : "left-[3px]"
                      }`}
                    />
                  </button>
                  <div>
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {desc}
                    </div>
                  </div>
                </div>
              ))}
              <div className="pt-2">
                <Button
                  onClick={() => saveMutation.mutate(form)}
                  disabled={saveMutation.isPending}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {saveMutation.isPending && (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  )}
                  Сохранить
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Budgets */}
        <TabsContent value="budgets">
          <Card>
            <CardHeader>
              <CardTitle className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Бюджеты и лимиты
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    field: "dailyApifyLimit",
                    label: "Дневной лимит Apify ($)",
                  },
                  {
                    field: "monthlyApifyLimit",
                    label: "Месячный лимит Apify ($)",
                  },
                  {
                    field: "dailyClaudeLimit",
                    label: "Дневной лимит Claude ($)",
                  },
                  {
                    field: "monthlyClaudeLimit",
                    label: "Месячный лимит Claude ($)",
                  },
                  {
                    field: "alertThreshold",
                    label: "Алерт при достижении (%)",
                  },
                  { field: "maxEmailPerDay", label: "Макс. email в день" },
                  { field: "maxTgPerDay", label: "Макс. TG сообщений в день" },
                  {
                    field: "messagePauseSeconds",
                    label: "Пауза между сообщениями (сек)",
                  },
                ].map(({ field, label }) => (
                  <div key={field}>
                    <label className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                      {label}
                    </label>
                    <Input
                      type="number"
                      value={form[field] ?? 0}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          [field]: parseInt(e.target.value) || 0,
                        }))
                      }
                    />
                  </div>
                ))}
                <div className="col-span-2 mt-2">
                  <Button
                    onClick={() => saveMutation.mutate(form)}
                    disabled={saveMutation.isPending}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  >
                    {saveMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    )}
                    Сохранить
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Team */}
        <TabsContent value="team">
          <EmptyState
            icon={Users}
            title="Команда"
            description="Управление командой и ролями появится в следующем обновлении"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

const SECTIONS = [
  { key: "dashboard", label: "Dashboard", icon: Target },
  { key: "parsers", label: "Парсеры", icon: Search },
  { key: "leads", label: "Лиды", icon: Users },
  { key: "campaigns", label: "Кампании", icon: Send },
  { key: "analytics", label: "Аналитика", icon: BarChart3 },
  { key: "settings", label: "Настройки", icon: Settings },
] as const;

export function MarketingClient({ workspaceId }: Props) {
  const [section, setSection] = useState<string>("dashboard");

  const { data: workerStatus } = useQuery({
    queryKey: ["mkt-worker", workspaceId],
    queryFn: () =>
      fetchApi(api(workspaceId, "/worker")).catch(() => ({ running: false })),
    refetchInterval: 10000,
  });

  const { data: analytics } = useQuery({
    queryKey: ["mkt-analytics", workspaceId],
    queryFn: () => fetchApi(api(workspaceId, "/analytics")).catch(() => ({})),
  });

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Sidebar */}
      <div className="w-56 border-r bg-card flex flex-col shrink-0">
        <div className="p-4 border-b">
          <div className="text-[10px] font-bold uppercase text-muted-foreground tracking-widest">
            Модуль
          </div>
          <div className="text-lg font-extrabold text-emerald-500">
            Маркетинг
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                section === s.key
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <s.icon className="h-4 w-4" />
              {s.label}
              {s.key === "leads" && (analytics?.totalLeads ?? 0) > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-auto text-[10px] px-1.5"
                >
                  {analytics.totalLeads}
                </Badge>
              )}
            </button>
          ))}
        </nav>
        {/* Worker status footer */}
        <div className="p-3 border-t text-xs">
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${
                workerStatus?.running
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-muted-foreground/30"
              }`}
            />
            <span className="text-muted-foreground">
              Worker: {workerStatus?.running ? "Активен" : "Остановлен"}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-6">
        {section === "dashboard" && (
          <DashboardSection workspaceId={workspaceId} />
        )}
        {section === "parsers" && <ParsersSection workspaceId={workspaceId} />}
        {section === "leads" && <LeadsSection workspaceId={workspaceId} />}
        {section === "campaigns" && (
          <CampaignsSection workspaceId={workspaceId} />
        )}
        {section === "analytics" && (
          <AnalyticsSection workspaceId={workspaceId} />
        )}
        {section === "settings" && (
          <SettingsSection workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
