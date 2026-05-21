"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useQuery } from "@tanstack/react-query";
import { BarChart3, DollarSign } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type MarketingSectionProps,
  api,
  fetchApi,
  SourceBadge,
  EmptyState,
} from "./marketing-shared";

export function AnalyticsSection({ workspaceId }: MarketingSectionProps) {
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
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Всего лидов
                </div>
                <div className="text-3xl font-extrabold">{totalLeads}</div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Источник
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Всего лидов
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      С email
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Qualified
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Contacted
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Ответили
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Конверсия
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
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
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Всего за месяц
                </div>
                <div className="text-3xl font-extrabold">
                  ${analytics?.totalCost?.toFixed(2) ?? "0.00"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  Apify
                </div>
                <div className="text-3xl font-extrabold">
                  ${analytics?.apifyCost?.toFixed(2) ?? "0.00"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
                  YouTube API
                </div>
                <div className="text-3xl font-extrabold">
                  ${analytics?.youtubeCost?.toFixed(2) ?? "0.00"}
                </div>
              </CardContent>
            </Card>
            <Card className="hover:border-emerald-500/30 transition-colors">
              <CardContent className="pt-4 pb-4">
                <div className="text-xs font-bold uppercase text-muted-foreground tracking-wider mb-2">
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
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Сервис
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Тип
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Сумма
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                      Единиц
                    </th>
                    <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
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
