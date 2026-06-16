"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Search,
  Users,
  Plus,
  ExternalLink,
  Mail,
  X,
  Download,
  Filter,
  Loader2,
  Zap,
  AlertCircle,
  Eye,
  ChevronRight,
  ChevronLeft,
  Target,
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
import { trackAction } from "@/lib/services/action-tracker";
import {
  type MarketingSectionProps,
  api,
  fetchApi,
  postApi,
  patchApi,
  SourceBadge,
  ScoreBadge,
  formatNumber,
  EmptyState,
  SOURCES,
  DIALOGUE_STAGES,
  LEAD_STATUSES,
  dialogueStageLabel,
  dialogueStageColor,
  leadStatusLabel,
  leadStatusColor,
} from "./marketing-shared";

// Radix <Select> forbids an empty-string <SelectItem> value. Use a sentinel for
// the "all / no filter" option and map it back to "" in state, so the
// `if (filter) params.set(...)` query logic is unchanged.
const ALL_FILTER = "__all__";

export function LeadsSection({ workspaceId }: MarketingSectionProps) {
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
    onSuccess: (_res, leadId) => {
      trackAction("marketing:lead:enrich", `marketing:lead:enrich`, leadId);
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
    onSuccess: (_res, vars) => {
      if (vars.data.dialogueStage) {
        toastSuccess(`Стадия: ${dialogueStageLabel(vars.data.dialogueStage)}`);
      } else if (vars.data.leadStatus) {
        toastSuccess(`Статус: ${leadStatusLabel(vars.data.leadStatus)}`);
      }
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
              value={sourceFilter || ALL_FILTER}
              onValueChange={(v) => {
                setSourceFilter(v === ALL_FILTER ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue placeholder="Все источники" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>Все источники</SelectItem>
                {SOURCES.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={statusFilter || ALL_FILTER}
              onValueChange={(v) => {
                setStatusFilter(v === ALL_FILTER ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-32">
                <SelectValue placeholder="Все статусы" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>Все статусы</SelectItem>
                <SelectItem value="new">new</SelectItem>
                <SelectItem value="enriched">enriched</SelectItem>
                <SelectItem value="qualified">qualified</SelectItem>
                <SelectItem value="contacted">contacted</SelectItem>
                <SelectItem value="rejected">rejected</SelectItem>
                <SelectItem value="converted">converted</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={scoreFilter || ALL_FILTER}
              onValueChange={(v) => {
                setScoreFilter(v === ALL_FILTER ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-8 text-xs w-32">
                <SelectValue placeholder="AI-скоринг" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>AI-скоринг</SelectItem>
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
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  selectedIds.forEach((id) =>
                    updateLeadMutation.mutate({
                      leadId: id,
                      data: { leadStatus: "IN_WORK" },
                    }),
                  );
                  setSelectedIds(new Set());
                }}
              >
                → В работу
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  selectedIds.forEach((id) =>
                    updateLeadMutation.mutate({
                      leadId: id,
                      data: { dialogueStage: "NOT_CONTACTED" },
                    }),
                  );
                  setSelectedIds(new Set());
                }}
              >
                ↺ Сбросить стадию
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs text-red-500 hover:text-red-400"
                onClick={() => {
                  selectedIds.forEach((id) =>
                    updateLeadMutation.mutate({
                      leadId: id,
                      data: { leadStatus: "REJECTED" },
                    }),
                  );
                  setSelectedIds(new Set());
                }}
              >
                <X className="h-3 w-3 mr-1" /> Отклонить
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => setSelectedIds(new Set())}
              >
                Сброс
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
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        Канал
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        Источник
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        Подписчики
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        Avg Views
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        ER
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        Контакты
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        AI Score
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        Статус
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
                        Стадия диалога
                      </th>
                      <th className="text-left p-2.5 font-bold text-xs uppercase text-muted-foreground tracking-wide">
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
                            <div className="w-7 h-7 rounded-full bg-muted shrink-0 flex items-center justify-center text-xs font-bold text-muted-foreground">
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
                                <div className="text-xs text-muted-foreground">
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
                                className="bg-emerald-500/10 text-emerald-500 text-xs px-1.5 py-0"
                              >
                                <Mail className="h-2.5 w-2.5" />
                              </Badge>
                            )}
                            {lead.telegramUsername && (
                              <Badge
                                variant="outline"
                                className="bg-blue-500/10 text-blue-500 text-xs px-1.5 py-0"
                              >
                                TG
                              </Badge>
                            )}
                            {lead.instagramUsername && (
                              <Badge
                                variant="outline"
                                className="bg-purple-500/10 text-purple-500 text-xs px-1.5 py-0"
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
                          <Select
                            value={lead.leadStatus || "PENDING"}
                            onValueChange={(val) =>
                              updateLeadMutation.mutate({
                                leadId: lead.id,
                                data: { leadStatus: val },
                              })
                            }
                          >
                            <SelectTrigger
                              className={`h-7 text-xs w-[110px] border-0 px-2 font-bold ${leadStatusColor(lead.leadStatus || "PENDING")}`}
                            >
                              <SelectValue>
                                {leadStatusLabel(lead.leadStatus || "PENDING")}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {LEAD_STATUSES.map((s) => (
                                <SelectItem key={s.value} value={s.value}>
                                  <span className={`font-medium ${s.color}`}>
                                    {s.label}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="p-2.5">
                          <Select
                            value={lead.dialogueStage || "NOT_CONTACTED"}
                            onValueChange={(val) =>
                              updateLeadMutation.mutate({
                                leadId: lead.id,
                                data: { dialogueStage: val },
                              })
                            }
                          >
                            <SelectTrigger
                              className={`h-7 text-xs w-[130px] border-0 px-2 font-bold ${dialogueStageColor(lead.dialogueStage || "NOT_CONTACTED")}`}
                            >
                              <SelectValue>
                                {dialogueStageLabel(
                                  lead.dialogueStage || "NOT_CONTACTED",
                                )}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {DIALOGUE_STAGES.map((s) => (
                                <SelectItem key={s.value} value={s.value}>
                                  <span className={`font-medium ${s.color}`}>
                                    {s.label}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
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
                            <div className="text-xs uppercase text-muted-foreground">
                              Подписчики
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-base font-bold">
                              {lead.avgViews
                                ? formatNumber(lead.avgViews)
                                : "—"}
                            </div>
                            <div className="text-xs uppercase text-muted-foreground">
                              Avg Views
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-base font-bold">
                              {lead.engagementRate
                                ? `${lead.engagementRate}%`
                                : "—"}
                            </div>
                            <div className="text-xs uppercase text-muted-foreground">
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
                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                              <div className="text-xs text-muted-foreground mt-0.5">
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
                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Контакты
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-xs">
                      {lead.email && (
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className="bg-emerald-500/10 text-emerald-500 text-xs w-6 justify-center"
                          >
                            <Mail className="h-2.5 w-2.5" />
                          </Badge>
                          <span className="truncate">{lead.email}</span>
                          {lead.emailType && (
                            <Badge
                              variant="outline"
                              className="bg-emerald-500/10 text-emerald-500 text-xs ml-auto shrink-0"
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
                            className="bg-blue-500/10 text-blue-500 text-xs w-6 justify-center"
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
                            className="bg-purple-500/10 text-purple-500 text-xs w-6 justify-center"
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
                            className="bg-muted text-muted-foreground text-xs w-6 justify-center"
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
                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      Статус
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2.5 text-xs">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">
                          Lead status
                        </span>
                        <Select
                          value={lead.leadStatus || "PENDING"}
                          onValueChange={(val) =>
                            updateLeadMutation.mutate({
                              leadId: lead.id,
                              data: { leadStatus: val },
                            })
                          }
                        >
                          <SelectTrigger
                            className={`h-7 text-xs w-[110px] border-0 px-2 font-bold ${leadStatusColor(lead.leadStatus || "PENDING")}`}
                          >
                            <SelectValue>
                              {leadStatusLabel(lead.leadStatus || "PENDING")}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {LEAD_STATUSES.map((s) => (
                              <SelectItem key={s.value} value={s.value}>
                                <span className={`font-medium ${s.color}`}>
                                  {s.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">AI Score</span>
                        <ScoreBadge score={lead.aiScore} />
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Диалог</span>
                        <Select
                          value={lead.dialogueStage || "NOT_CONTACTED"}
                          onValueChange={(val) =>
                            updateLeadMutation.mutate({
                              leadId: lead.id,
                              data: { dialogueStage: val },
                            })
                          }
                        >
                          <SelectTrigger
                            className={`h-7 text-xs w-[130px] border-0 px-2 font-bold ${dialogueStageColor(lead.dialogueStage || "NOT_CONTACTED")}`}
                          >
                            <SelectValue>
                              {dialogueStageLabel(
                                lead.dialogueStage || "NOT_CONTACTED",
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {DIALOGUE_STAGES.map((s) => (
                              <SelectItem key={s.value} value={s.value}>
                                <span className={`font-medium ${s.color}`}>
                                  {s.label}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Projects */}
                {lead.projects?.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                      <div className="text-xs text-muted-foreground mt-1">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
