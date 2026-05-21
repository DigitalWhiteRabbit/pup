"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Users,
  Check,
  X,
  Mail,
  MessageSquare,
  DollarSign,
  TrendingUp,
  Zap,
  Clock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type MarketingSectionProps,
  api,
  fetchApi,
  SourceBadge,
  EmptyState,
} from "./marketing-shared";

export function DashboardSection({ workspaceId }: MarketingSectionProps) {
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
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                      <div className="text-xs text-muted-foreground mt-0.5">
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
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                      <div className="text-xs text-muted-foreground">
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
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Ожидают действия
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-orange-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-orange-500">
                {pendingActions.awaitingReply}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Ждут ответа
              </div>
            </div>
            <div className="bg-yellow-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-yellow-500">
                {pendingActions.awaitingApproval}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Ждут одобрения
              </div>
            </div>
            <div className="bg-blue-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-blue-500">
                {pendingActions.newLeads}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Новые лиды
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
