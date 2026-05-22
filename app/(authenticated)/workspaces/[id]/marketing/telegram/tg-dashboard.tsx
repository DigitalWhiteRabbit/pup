"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useQuery } from "@tanstack/react-query";
import {
  Users,
  Globe,
  Flame,
  ShieldBan,
  Clock,
  AlertTriangle,
  CheckCircle,
  Info,
  XCircle,
  Import,
  Plus,
  Settings,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type TgSectionProps,
  tgApi,
  tgFetch,
  EmptyState,
  formatDateTime,
} from "./tg-shared";

// ── Severity icon mapping for audit log events ──

function severityIcon(severity: string) {
  switch (severity?.toUpperCase()) {
    case "ERROR":
    case "CRITICAL":
      return (
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-red-500/10 text-red-500">
          <XCircle className="h-3 w-3" />
        </div>
      );
    case "WARNING":
      return (
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-yellow-500/10 text-yellow-500">
          <AlertTriangle className="h-3 w-3" />
        </div>
      );
    case "SUCCESS":
      return (
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-emerald-500/10 text-emerald-500">
          <CheckCircle className="h-3 w-3" />
        </div>
      );
    default:
      return (
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-blue-500/10 text-blue-500">
          <Info className="h-3 w-3" />
        </div>
      );
  }
}

// ── Dashboard Section ──

interface QuickActionsProps {
  onNavigate: (section: string) => void;
}

export function DashboardSection({
  workspaceId,
  onNavigate,
}: TgSectionProps & QuickActionsProps) {
  const { data: dashStats, isLoading: dashLoading } = useQuery({
    queryKey: ["tg-dashboard", workspaceId],
    queryFn: () => tgFetch(tgApi(workspaceId, "/dashboard/stats")),
  });

  const { data: accountStats, isLoading: accLoading } = useQuery({
    queryKey: ["tg-accounts-stats", workspaceId],
    queryFn: () => tgFetch(tgApi(workspaceId, "/accounts/stats")),
  });

  const isLoading = dashLoading || accLoading;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3.5">
          <Skeleton className="lg:col-span-3 h-64 rounded-xl" />
          <div className="lg:col-span-2 space-y-3.5">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  const totalAccounts = accountStats?.total ?? 0;
  const activeAccounts = accountStats?.by_status?.ACTIVE ?? 0;
  const warmingAccounts = accountStats?.by_status?.WARMING ?? 0;
  const bannedAccounts =
    (accountStats?.by_status?.BANNED ?? 0) +
    (accountStats?.by_status?.DEAD ?? 0);
  const spamBlocked = accountStats?.by_status?.SPAM_BLOCKED ?? 0;
  const totalProxies = dashStats?.proxies?.total ?? 0;
  const activeProxies = dashStats?.proxies?.active ?? 0;

  // Account pool distribution for the sidebar card
  const poolStatuses = [
    {
      key: "ACTIVE",
      label: "Активные",
      count: activeAccounts,
      color: "bg-emerald-500",
    },
    {
      key: "WARMING",
      label: "Прогрев",
      count: warmingAccounts,
      color: "bg-orange-500",
    },
    {
      key: "IMPORTED",
      label: "Импорт",
      count: accountStats?.by_status?.IMPORTED ?? 0,
      color: "bg-blue-500",
    },
    {
      key: "PAUSED",
      label: "Пауза",
      count: accountStats?.by_status?.PAUSED ?? 0,
      color: "bg-gray-400",
    },
    {
      key: "FLOOD_WAIT",
      label: "Флуд-блок",
      count: accountStats?.by_status?.FLOOD_WAIT ?? 0,
      color: "bg-yellow-500",
    },
    {
      key: "SPAM_BLOCKED",
      label: "Спам-блок",
      count: spamBlocked,
      color: "bg-red-400",
    },
    {
      key: "BANNED",
      label: "Бан",
      count: accountStats?.by_status?.BANNED ?? 0,
      color: "bg-red-600",
    },
    {
      key: "DEAD",
      label: "Мёртвые",
      count: accountStats?.by_status?.DEAD ?? 0,
      color: "bg-gray-600",
    },
  ].filter((s) => s.count > 0);

  const events: any[] = dashStats?.recent_events ?? [];

  return (
    <div className="space-y-4">
      {/* Row 1: KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* Total accounts */}
        <Card className="hover:border-blue-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
              Всего аккаунтов
            </div>
            <div className="text-3xl font-extrabold">{totalAccounts}</div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <Users className="h-3 w-3" />
              {activeAccounts} активных / {totalAccounts}
            </div>
          </CardContent>
        </Card>

        {/* Active proxies */}
        <Card className="hover:border-blue-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
              Активных прокси
            </div>
            <div className="text-3xl font-extrabold">
              {activeProxies}
              <span className="text-xs text-muted-foreground ml-1">
                /{totalProxies}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <Globe className="h-3 w-3" />В пуле
            </div>
          </CardContent>
        </Card>

        {/* Warming */}
        <Card className="hover:border-blue-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
              На прогреве
            </div>
            <div className="text-3xl font-extrabold text-orange-500">
              {warmingAccounts}
            </div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <Flame className="h-3 w-3" />
              Уровень прогрева
            </div>
            {warmingAccounts > 0 && (
              <div className="mt-1.5 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-orange-500 rounded-full transition-all"
                  style={{
                    width: `${totalAccounts > 0 ? Math.round((warmingAccounts / totalAccounts) * 100) : 0}%`,
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Banned + Dead */}
        <Card className="hover:border-red-500/30 transition-colors">
          <CardContent className="pt-4 pb-4">
            <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
              Заблокировано
            </div>
            <div className="text-3xl font-extrabold text-red-500">
              {bannedAccounts}
            </div>
            <div className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
              <ShieldBan className="h-3 w-3" />
              Бан + мёртвые
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Activity Feed + Quick Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3.5">
        {/* Activity feed */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Последние события
            </CardTitle>
          </CardHeader>
          <CardContent>
            {events.length > 0 ? (
              <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
                {events.slice(0, 15).map((event: any, i: number) => (
                  <div
                    key={event.id ?? i}
                    className="flex gap-3 p-2.5 rounded-lg bg-muted/30 border border-border text-xs"
                  >
                    {severityIcon(event.severity)}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{event.message}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {event.entity_type && `${event.entity_type} -- `}
                        {formatDateTime(event.created_at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={Clock}
                title="Нет событий"
                description="Активность появится после импорта аккаунтов и начала работы"
              />
            )}
          </CardContent>
        </Card>

        {/* Quick stats sidebar */}
        <div className="lg:col-span-2 space-y-3.5">
          {/* Account pool summary */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Статус пула аккаунтов
              </CardTitle>
            </CardHeader>
            <CardContent>
              {poolStatuses.length > 0 ? (
                <div className="space-y-2.5">
                  {poolStatuses.map((s) => (
                    <div key={s.key} className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium">{s.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {s.count}
                          </span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full ${s.color} rounded-full transition-all`}
                            style={{
                              width: `${totalAccounts > 0 ? Math.round((s.count / totalAccounts) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground text-center py-6">
                  Нет аккаунтов в пуле
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick actions */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Быстрые действия
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start text-xs h-9"
                onClick={() => onNavigate("accounts")}
              >
                <Import className="h-3.5 w-3.5 mr-2" />
                Импорт аккаунтов
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-xs h-9"
                onClick={() => onNavigate("proxies")}
              >
                <Plus className="h-3.5 w-3.5 mr-2" />
                Добавить прокси
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-xs h-9"
                onClick={() => onNavigate("settings")}
              >
                <Settings className="h-3.5 w-3.5 mr-2" />
                Настройки
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
