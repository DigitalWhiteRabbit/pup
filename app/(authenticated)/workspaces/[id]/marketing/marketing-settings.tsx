"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, Flame } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastSuccess, toastApiError } from "@/lib/toast";
import {
  type MarketingSectionProps,
  api,
  fetchApi,
  patchApi,
  EmptyState,
} from "./marketing-shared";

export function SettingsSection({ workspaceId }: MarketingSectionProps) {
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
          <TabsTrigger value="warmup">Прогрев</TabsTrigger>
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
                        ? "bg-emerald-500/10 text-emerald-500 text-xs"
                        : "bg-orange-500/10 text-orange-500 text-xs"
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
                      ? "bg-emerald-500/10 text-emerald-500 text-xs"
                      : "bg-orange-500/10 text-orange-500 text-xs"
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
                      ? "bg-emerald-500/10 text-emerald-500 text-xs"
                      : "bg-orange-500/10 text-orange-500 text-xs"
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
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Правила AI-скоринга
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
                  <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                    <div className="text-xs text-muted-foreground">{desc}</div>
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
              <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
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
                    <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
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

        {/* Warm-up */}
        <TabsContent value="warmup">
          <WarmupSection
            workspaceId={workspaceId}
            config={config}
            saveMutation={saveMutation}
          />
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

// ─── Warm-up sub-section ─────────────────────────────────────────────────────

const DEFAULT_WARMUP_SCHEDULE = [
  5, 10, 20, 30, 50, 75, 100, 125, 150, 175, 200, 200, 200, 200,
];

function WarmupSection({
  workspaceId,
  config,
  saveMutation,
}: {
  workspaceId: string;
  config: any;
  saveMutation: any;
}) {
  const warmupEnabled = config?.warmupEnabled ?? false;
  const warmupStartDate = useMemo(
    () => (config?.warmupStartDate ? new Date(config.warmupStartDate) : null),
    [config?.warmupStartDate],
  );

  const schedule: number[] = useMemo(() => {
    if (!config?.warmupSchedule) return DEFAULT_WARMUP_SCHEDULE;
    try {
      const parsed = JSON.parse(config.warmupSchedule);
      return Array.isArray(parsed) && parsed.length > 0
        ? parsed
        : DEFAULT_WARMUP_SCHEDULE;
    } catch {
      return DEFAULT_WARMUP_SCHEDULE;
    }
  }, [config?.warmupSchedule]);

  const currentDay = useMemo(() => {
    if (!warmupEnabled || !warmupStartDate) return null;
    return Math.max(
      0,
      Math.floor((Date.now() - warmupStartDate.getTime()) / 86_400_000),
    );
  }, [warmupEnabled, warmupStartDate]);

  const effectiveLimit = useMemo(() => {
    const cap: number = config?.dailyCapEmail ?? 200;
    if (currentDay === null) return cap;
    const rawLimit: number | undefined =
      currentDay < schedule.length
        ? schedule[currentDay]
        : schedule[schedule.length - 1];
    const warmupLimit: number = rawLimit ?? cap;
    return Math.min(warmupLimit, cap);
  }, [currentDay, schedule, config?.dailyCapEmail]);

  const warmupComplete = currentDay !== null && currentDay >= schedule.length;

  const { data: workerStatus } = useQuery({
    queryKey: ["mkt-worker", workspaceId],
    queryFn: () =>
      fetch(`/api/workspaces/${workspaceId}/marketing/worker`).then((r) =>
        r.json(),
      ),
    refetchInterval: warmupEnabled ? 15000 : false,
  });

  function handleToggleWarmup() {
    if (!warmupEnabled) {
      // Turn ON: set start date to now
      saveMutation.mutate({
        warmupEnabled: true,
        warmupStartDate: new Date().toISOString(),
      });
    } else {
      // Turn OFF
      saveMutation.mutate({
        warmupEnabled: false,
        warmupStartDate: null,
      });
    }
  }

  function handleResetWarmup() {
    saveMutation.mutate({
      warmupEnabled: true,
      warmupStartDate: new Date().toISOString(),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Flame className="h-3.5 w-3.5" />
          Прогрев домена
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Description */}
        <p className="text-xs text-muted-foreground leading-relaxed">
          Новые email-домены нужно прогревать — постепенно увеличивая объём
          отправок, чтобы не попасть в спам. Прогрев автоматически ограничивает
          дневной лимит email по расписанию на 14 дней.
        </p>

        {/* Toggle */}
        <div className="flex items-center gap-3 p-3 bg-muted/20 rounded-lg">
          <button
            className={`w-10 h-[22px] rounded-full relative shrink-0 transition-colors ${
              warmupEnabled ? "bg-emerald-500" : "bg-muted-foreground/30"
            }`}
            onClick={handleToggleWarmup}
            disabled={saveMutation.isPending}
          >
            <div
              className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-transform ${
                warmupEnabled ? "left-[22px]" : "left-[3px]"
              }`}
            />
          </button>
          <div>
            <div className="text-sm font-medium">
              Режим прогрева{" "}
              {warmupEnabled ? (
                <Badge className="ml-1.5 bg-emerald-500/10 text-emerald-500 text-[10px]">
                  Активен
                </Badge>
              ) : (
                <Badge variant="outline" className="ml-1.5 text-[10px]">
                  Выключен
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {warmupEnabled && warmupStartDate
                ? `Старт: ${warmupStartDate.toLocaleDateString("ru-RU")} | День ${(currentDay ?? 0) + 1} из ${schedule.length}`
                : "Включите для постепенного увеличения лимита отправок"}
            </div>
          </div>
        </div>

        {/* Current status */}
        {warmupEnabled && warmupStartDate && (
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-blue-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-blue-500">
                {(currentDay ?? 0) + 1}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Текущий день
              </div>
            </div>
            <div className="bg-emerald-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-emerald-500">
                {effectiveLimit}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Лимит сегодня
              </div>
            </div>
            <div className="bg-orange-500/10 rounded-xl p-4 text-center">
              <div className="text-2xl font-extrabold text-orange-500">
                {workerStatus?.dailySentEmail ?? 0}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Отправлено
              </div>
            </div>
          </div>
        )}

        {/* Warm-up complete badge */}
        {warmupEnabled && warmupComplete && (
          <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 text-sm text-emerald-600 dark:text-emerald-400">
            Прогрев завершён. Домен отправляет на полную мощность (
            {config?.dailyCapEmail ?? 200} email/день). Можно выключить режим
            прогрева.
          </div>
        )}

        {/* Schedule visualization */}
        <div>
          <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-2">
            Расписание прогрева
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {schedule.map((limit, i) => {
              const isToday = currentDay === i && warmupEnabled;
              const isPast =
                currentDay !== null && i < currentDay && warmupEnabled;
              return (
                <div
                  key={i}
                  className={`rounded-lg p-2 text-center text-xs border transition-colors ${
                    isToday
                      ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 font-bold"
                      : isPast
                        ? "bg-muted/40 border-border/30 text-muted-foreground"
                        : "bg-muted/20 border-border/30"
                  }`}
                >
                  <div className="text-[10px] text-muted-foreground">
                    День {i + 1}
                  </div>
                  <div className="font-bold mt-0.5">{limit}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        {warmupEnabled && (
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleResetWarmup}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              )}
              Перезапустить прогрев
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
