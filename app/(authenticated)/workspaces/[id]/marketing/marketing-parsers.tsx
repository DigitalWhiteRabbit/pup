"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Search,
  Send,
  Play,
  Plus,
  Loader2,
  Clock,
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
import {
  type MarketingSectionProps,
  api,
  fetchApi,
  postApi,
  SourceBadge,
  EmptyState,
  SOURCES,
} from "./marketing-shared";

export function ParsersSection({ workspaceId }: MarketingSectionProps) {
  const router = useRouter();
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
                  className={`hover:border-emerald-500/30 transition-colors ${s.key === "YOUTUBE" ? "cursor-pointer" : ""}`}
                  onClick={
                    s.key === "YOUTUBE"
                      ? () =>
                          router.push(
                            `/workspaces/${workspaceId}/marketing/youtube`,
                          )
                      : undefined
                  }
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
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {s.desc}
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        connected
                          ? "bg-emerald-500/10 text-emerald-500 text-xs"
                          : "bg-muted text-muted-foreground text-xs"
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
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Название
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Источник
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Ключевики
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Расписание
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Посл. запуск
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
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
                              ? "bg-emerald-500/10 text-emerald-500 text-xs"
                              : task.status === "RUNNING"
                                ? "bg-blue-500/10 text-blue-500 text-xs"
                                : task.status === "QUEUED"
                                  ? "bg-yellow-500/10 text-yellow-500 text-xs"
                                  : task.status === "FAILED"
                                    ? "bg-red-500/10 text-red-500 text-xs"
                                    : "bg-muted text-muted-foreground text-xs"
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Дата
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Задача
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Источник
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Найдено
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Новых
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Стоимость
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Время
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
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
                              ? "bg-emerald-500/10 text-emerald-500 text-xs"
                              : run.status === "RUNNING"
                                ? "bg-blue-500/10 text-blue-500 text-xs"
                                : run.status === "FAILED"
                                  ? "bg-red-500/10 text-red-500 text-xs"
                                  : "bg-muted text-muted-foreground text-xs"
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
