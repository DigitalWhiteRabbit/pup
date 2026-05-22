"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Plus,
  Loader2,
  MessageSquare,
  Check,
  Megaphone,
  FlaskConical,
  Trash2,
  BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
  EmptyState,
} from "./marketing-shared";

// ─── A/B Variant Types ────────────────────────────────────────────────────

interface AbVariant {
  id: string;
  name: string;
  instructions: string;
}

interface AbStats {
  [variantId: string]: {
    sent: number;
    replied: number;
    interested: number;
  };
}

// ─── A/B Variant Editor ───────────────────────────────────────────────────

function AbVariantEditor({
  variants,
  onChange,
}: {
  variants: AbVariant[];
  onChange: (v: AbVariant[]) => void;
}) {
  const addVariant = useCallback(() => {
    const nextLetter = String.fromCharCode(65 + variants.length); // A, B, C...
    onChange([
      ...variants,
      { id: nextLetter, name: `Вариант ${nextLetter}`, instructions: "" },
    ]);
  }, [variants, onChange]);

  const removeVariant = useCallback(
    (idx: number) => {
      onChange(variants.filter((_, i) => i !== idx));
    },
    [variants, onChange],
  );

  const updateVariant = useCallback(
    (idx: number, field: keyof AbVariant, value: string) => {
      const updated = [...variants];
      updated[idx] = { ...updated[idx], [field]: value } as AbVariant;
      onChange(updated);
    },
    [variants, onChange],
  );

  return (
    <div className="space-y-3">
      {variants.map((v, idx) => (
        <div key={v.id} className="border rounded-lg p-3 space-y-2 bg-muted/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="bg-blue-500/10 text-blue-500 text-xs font-bold"
              >
                {v.id}
              </Badge>
              <Input
                value={v.name}
                onChange={(e) => updateVariant(idx, "name", e.target.value)}
                placeholder="Название варианта"
                className="h-7 text-xs w-48"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
              onClick={() => removeVariant(idx)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <textarea
            className="w-full min-h-[80px] bg-background border rounded-lg p-2.5 text-xs resize-y focus:border-emerald-500 focus:outline-none"
            value={v.instructions}
            onChange={(e) => updateVariant(idx, "instructions", e.target.value)}
            placeholder="Инструкции для AI: тон, подход, акценты. Пример: 'Используй формальный деловой тон. Начни с конкретной метрики канала.'"
          />
        </div>
      ))}
      {variants.length < 5 && (
        <Button
          variant="outline"
          size="sm"
          onClick={addVariant}
          className="text-xs"
        >
          <Plus className="h-3 w-3 mr-1" />
          Добавить вариант
        </Button>
      )}
      {variants.length < 2 && (
        <div className="text-xs text-muted-foreground">
          Добавьте минимум 2 варианта для A/B теста
        </div>
      )}
    </div>
  );
}

// ─── A/B Stats Display ────────────────────────────────────────────────────

function AbStatsDisplay({
  stats,
  variants,
}: {
  stats: AbStats | null;
  variants: AbVariant[];
}) {
  if (!stats || Object.keys(stats).length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-3 text-center">
        Пока нет данных. Статистика появится после отправки сообщений.
      </div>
    );
  }

  // Build variant name lookup
  const nameMap: Record<string, string> = {};
  for (const v of variants) {
    nameMap[v.id] = v.name;
  }

  return (
    <div className="space-y-2">
      {Object.entries(stats).map(([vid, s]) => {
        const replyRate =
          s.sent > 0 ? ((s.replied / s.sent) * 100).toFixed(1) : "0";
        const interestRate =
          s.sent > 0 ? ((s.interested / s.sent) * 100).toFixed(1) : "0";
        return (
          <div key={vid} className="border rounded-lg p-3 bg-muted/10">
            <div className="flex items-center gap-2 mb-2">
              <Badge
                variant="outline"
                className="bg-blue-500/10 text-blue-500 text-xs font-bold"
              >
                {vid}
              </Badge>
              <span className="text-xs font-medium">
                {nameMap[vid] || `Вариант ${vid}`}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="text-center p-2 bg-background rounded">
                <div className="text-lg font-extrabold">{s.sent}</div>
                <div className="text-xs text-muted-foreground">Отправлено</div>
              </div>
              <div className="text-center p-2 bg-background rounded">
                <div className="text-lg font-extrabold text-emerald-500">
                  {s.replied}
                  <span className="text-xs font-normal text-muted-foreground ml-1">
                    ({replyRate}%)
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">Ответили</div>
              </div>
              <div className="text-center p-2 bg-background rounded">
                <div className="text-lg font-extrabold text-yellow-500">
                  {s.interested}
                  <span className="text-xs font-normal text-muted-foreground ml-1">
                    ({interestRate}%)
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">Интерес</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────

export function CampaignsSection({ workspaceId }: MarketingSectionProps) {
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
  const [abEditProjectId, setAbEditProjectId] = useState<string | null>(null);
  const [abStatsProjectId, setAbStatsProjectId] = useState<string | null>(null);

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

  // A/B stats query — fetched when a specific project is selected for stats
  const abAnalyticsQuery = useQuery({
    queryKey: ["mkt-ab-stats", workspaceId, abStatsProjectId],
    queryFn: () =>
      fetchApi(api(workspaceId, `/analytics?projectId=${abStatsProjectId}`)),
    enabled: !!abStatsProjectId,
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
      trackAction("marketing:pitch:approve", `marketing:pitch:approve`);
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
      trackAction("marketing:pitch:reject", `marketing:pitch:reject`);
      toastSuccess("Сообщение отклонено");
      queryClient.invalidateQueries({ queryKey: ["mkt-pending", workspaceId] });
    },
    onError: toastApiError,
  });

  const updateAbTestMutation = useMutation({
    mutationFn: ({
      projectId,
      abTestEnabled,
      abVariants,
    }: {
      projectId: string;
      abTestEnabled: boolean;
      abVariants: AbVariant[];
    }) =>
      patchApi(api(workspaceId, `/projects/${projectId}`), {
        abTestEnabled,
        abVariants,
      }),
    onSuccess: () => {
      toastSuccess("A/B тест обновлен");
      queryClient.invalidateQueries({
        queryKey: ["mkt-projects", workspaceId],
      });
      setAbEditProjectId(null);
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

  // Parse variants for the project being edited
  const editProject = abEditProjectId
    ? projectsQuery.data?.find((p: any) => p.id === abEditProjectId)
    : null;
  const [editAbEnabled, setEditAbEnabled] = useState(false);
  const [editAbVariants, setEditAbVariants] = useState<AbVariant[]>([]);

  // When opening the editor, load current values
  const openAbEditor = useCallback((project: any) => {
    setAbEditProjectId(project.id);
    setEditAbEnabled(project.abTestEnabled ?? false);
    try {
      const parsed = project.abVariants ? JSON.parse(project.abVariants) : [];
      setEditAbVariants(Array.isArray(parsed) ? parsed : []);
    } catch {
      setEditAbVariants([]);
    }
  }, []);

  const openAbStats = useCallback((project: any) => {
    setAbStatsProjectId(project.id);
  }, []);

  // Parse variants for stats display
  const statsProject = abStatsProjectId
    ? projectsQuery.data?.find((p: any) => p.id === abStatsProjectId)
    : null;
  let statsVariants: AbVariant[] = [];
  if (statsProject?.abVariants) {
    try {
      const parsed = JSON.parse(statsProject.abVariants);
      statsVariants = Array.isArray(parsed) ? parsed : [];
    } catch {
      // ignore
    }
  }

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
                className="ml-1.5 text-xs px-1.5 py-0 h-4"
              >
                {dialogues.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="approvals">
            Одобрение
            {pending.length > 0 && (
              <Badge className="ml-1.5 text-xs px-1.5 py-0 h-4 bg-yellow-500 text-black">
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
                        <div className="text-base font-bold flex items-center gap-2">
                          {project.name}
                          {project.abTestEnabled && (
                            <Badge
                              variant="outline"
                              className="bg-blue-500/10 text-blue-500 text-xs"
                            >
                              <FlaskConical className="h-3 w-3 mr-1" />
                              A/B
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {project.segmentName &&
                            `Сегмент: ${project.segmentName} · `}
                          Каналы: {project.channels || "Email"}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-blue-500"
                          onClick={() => openAbEditor(project)}
                          title="Настроить A/B тест"
                        >
                          <FlaskConical className="h-3.5 w-3.5 mr-1" />
                          A/B
                        </Button>
                        {project.abTestEnabled && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-emerald-500"
                            onClick={() => openAbStats(project)}
                            title="Статистика A/B теста"
                          >
                            <BarChart3 className="h-3.5 w-3.5 mr-1" />
                            Стат
                          </Button>
                        )}
                        <Badge
                          variant="outline"
                          className={
                            project.status === "ACTIVE"
                              ? "bg-emerald-500/10 text-emerald-500 text-xs"
                              : project.status === "DRAFT"
                                ? "bg-yellow-500/10 text-yellow-500 text-xs"
                                : project.status === "PAUSED"
                                  ? "bg-orange-500/10 text-orange-500 text-xs"
                                  : "bg-muted text-muted-foreground text-xs"
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
                          <div className="text-xs text-muted-foreground mt-0.5">
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
                              ? "bg-emerald-500/10 text-emerald-500 text-xs"
                              : tpl.channel === "TELEGRAM"
                                ? "bg-blue-500/10 text-blue-500 text-xs"
                                : "bg-muted text-muted-foreground text-xs"
                          }
                        >
                          {tpl.channel}
                        </Badge>
                        {tpl.language && (
                          <Badge
                            variant="outline"
                            className="bg-blue-500/10 text-blue-500 text-xs"
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                    <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                    <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">
                        {d.lastMessage || "Нет сообщений"}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
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
                              <div className="text-xs text-purple-500 font-semibold mb-1">
                                AI предлагает ответ:
                              </div>
                            )}
                            <div className="whitespace-pre-wrap">
                              {msg.body}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {msg.sender ||
                                (msg.direction === "OUT" ? "AI Agent" : "Lead")}
                              {msg.abVariantId && (
                                <Badge
                                  variant="outline"
                                  className="ml-1.5 bg-blue-500/10 text-blue-500 text-[10px] px-1 py-0"
                                >
                                  {msg.abVariantId}
                                </Badge>
                              )}
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
                        <div className="text-xs text-muted-foreground">
                          {item.channel || "Email"} · Кампания:{" "}
                          {item.projectName || item.project?.name || "---"}
                          {item.abVariantId && (
                            <Badge
                              variant="outline"
                              className="ml-1.5 bg-blue-500/10 text-blue-500 text-[10px] px-1 py-0"
                            >
                              Вариант {item.abVariantId}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {item.tag && (
                        <Badge
                          variant="outline"
                          className={
                            item.tag === "price"
                              ? "bg-yellow-500/10 text-yellow-500 text-xs"
                              : item.tag === "first"
                                ? "bg-orange-500/10 text-orange-500 text-xs"
                                : "bg-muted text-muted-foreground text-xs"
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

      {/* A/B Test Editor Dialog */}
      <Dialog
        open={!!abEditProjectId}
        onOpenChange={(open) => !open && setAbEditProjectId(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-blue-500" />
              A/B Тест — {editProject?.name || ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Включить A/B тест</div>
                <div className="text-xs text-muted-foreground">
                  Лиды будут случайно распределяться по вариантам
                </div>
              </div>
              <Switch
                checked={editAbEnabled}
                onCheckedChange={setEditAbEnabled}
              />
            </div>

            {editAbEnabled && (
              <>
                <div className="border-t pt-3">
                  <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-2">
                    Варианты питчей
                  </div>
                  <AbVariantEditor
                    variants={editAbVariants}
                    onChange={setEditAbVariants}
                  />
                </div>
              </>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                onClick={() =>
                  abEditProjectId &&
                  updateAbTestMutation.mutate({
                    projectId: abEditProjectId,
                    abTestEnabled: editAbEnabled,
                    abVariants: editAbVariants,
                  })
                }
                disabled={
                  updateAbTestMutation.isPending ||
                  (editAbEnabled && editAbVariants.length < 2)
                }
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {updateAbTestMutation.isPending && (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                )}
                Сохранить
              </Button>
              <Button
                variant="outline"
                onClick={() => setAbEditProjectId(null)}
              >
                Отмена
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* A/B Stats Dialog */}
      <Dialog
        open={!!abStatsProjectId}
        onOpenChange={(open) => !open && setAbStatsProjectId(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-emerald-500" />
              Статистика A/B — {statsProject?.name || ""}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2">
            {abAnalyticsQuery.isLoading ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
              </div>
            ) : (
              <AbStatsDisplay
                stats={abAnalyticsQuery.data?.abTestStats ?? null}
                variants={statsVariants}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
