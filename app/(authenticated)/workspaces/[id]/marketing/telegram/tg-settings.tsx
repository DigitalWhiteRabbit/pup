"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastSuccess, toastApiError } from "@/lib/toast";
import { type TgSectionProps, tgApi, tgFetch, tgPatch } from "./tg-shared";

export function SettingsSection({ workspaceId }: TgSectionProps) {
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ["tg-settings", workspaceId],
    queryFn: () => tgFetch(tgApi(workspaceId, "/settings")),
  });

  const [form, setForm] = useState<Record<string, any>>({});
  const [initialized, setInitialized] = useState(false);

  // Initialize form from loaded config
  if (config && !initialized) {
    setForm({
      // AI settings
      ai_model: config.ai_model || "claude-sonnet-4-20250514",
      ai_monthly_budget: config.ai_monthly_budget ?? 50,
      // Daily limits
      daily_dm_limit: config.daily_dm_limit ?? 30,
      daily_chat_limit: config.daily_chat_limit ?? 20,
      daily_comment_limit: config.daily_comment_limit ?? 50,
      daily_invite_limit: config.daily_invite_limit ?? 10,
      daily_join_limit: config.daily_join_limit ?? 5,
      // Safety
      active_hours_start: config.active_hours_start ?? 9,
      active_hours_end: config.active_hours_end ?? 22,
      flood_wait_threshold: config.flood_wait_threshold ?? 300,
      emergency_ban_ratio: config.emergency_ban_ratio ?? 0.3,
      emergency_spam_ratio: config.emergency_spam_ratio ?? 0.2,
      // Telegram API
      app_id: config.app_id || "",
      app_hash: config.app_hash || "",
    });
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (data: Record<string, any>) =>
      tgPatch(tgApi(workspaceId, "/settings"), data),
    onSuccess: () => {
      toastSuccess("Настройки сохранены");
      queryClient.invalidateQueries({
        queryKey: ["tg-settings", workspaceId],
      });
    },
    onError: toastApiError,
  });

  const [showApiHash, setShowApiHash] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* AI Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Настройки AI
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Модель
              </label>
              <Select
                value={form.ai_model || "claude-sonnet-4-20250514"}
                onValueChange={(v) => setForm((p) => ({ ...p, ai_model: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-sonnet-4-20250514">
                    Claude Sonnet 4
                  </SelectItem>
                  <SelectItem value="claude-haiku-4-20250514">
                    Claude Haiku 4
                  </SelectItem>
                  <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Месячный бюджет ($)
              </label>
              <Input
                type="number"
                value={form.ai_monthly_budget ?? 50}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    ai_monthly_budget: parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </div>
          </div>
          <div className="mt-4">
            <Button
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              size="sm"
            >
              {saveMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Сохранить
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Daily Limits */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Дневные лимиты
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { field: "daily_dm_limit", label: "ЛС (DM)" },
              { field: "daily_chat_limit", label: "Сообщения в чатах" },
              { field: "daily_comment_limit", label: "Комментарии" },
              { field: "daily_invite_limit", label: "Инвайты" },
              { field: "daily_join_limit", label: "Подписки на каналы" },
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
          </div>
          <div className="mt-4">
            <Button
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              size="sm"
            >
              {saveMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Сохранить
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Safety */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Безопасность
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Начало активных часов
              </label>
              <Input
                type="number"
                min={0}
                max={23}
                value={form.active_hours_start ?? 9}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    active_hours_start: parseInt(e.target.value) || 0,
                  }))
                }
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Конец активных часов
              </label>
              <Input
                type="number"
                min={0}
                max={23}
                value={form.active_hours_end ?? 22}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    active_hours_end: parseInt(e.target.value) || 0,
                  }))
                }
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Flood wait порог (сек)
              </label>
              <Input
                type="number"
                value={form.flood_wait_threshold ?? 300}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    flood_wait_threshold: parseInt(e.target.value) || 0,
                  }))
                }
              />
            </div>
          </div>

          <Separator className="my-4" />

          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase text-muted-foreground tracking-wider">
              Аварийная остановка
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Если доля заблокированных аккаунтов превысит пороговое значение,
              все операции будут автоматически остановлены.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 mt-3">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Порог бана (доля)
              </label>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={form.emergency_ban_ratio ?? 0.3}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    emergency_ban_ratio: parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                Порог спам-блока (доля)
              </label>
              <Input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={form.emergency_spam_ratio ?? 0.2}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    emergency_spam_ratio: parseFloat(e.target.value) || 0,
                  }))
                }
              />
            </div>
          </div>

          <div className="mt-4">
            <Button
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              size="sm"
            >
              {saveMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Сохранить
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Telegram API */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Telegram API
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground leading-relaxed mb-4">
            Параметры Telegram API из{" "}
            <span className="font-mono text-foreground">my.telegram.org</span>.
            Требуются для авторизации аккаунтов.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                App ID
              </label>
              <Input
                value={form.app_id || ""}
                onChange={(e) =>
                  setForm((p) => ({ ...p, app_id: e.target.value }))
                }
                placeholder="12345678"
                className="text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1 block">
                App Hash
              </label>
              <div className="flex gap-2">
                <Input
                  type={showApiHash ? "text" : "password"}
                  value={form.app_hash || ""}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, app_hash: e.target.value }))
                  }
                  placeholder="0123456789abcdef..."
                  className="text-sm flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs h-10 w-20"
                  onClick={() => setShowApiHash((v) => !v)}
                >
                  {showApiHash ? "Скрыть" : "Показать"}
                </Button>
              </div>
            </div>
          </div>
          <div className="mt-4">
            <Button
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              size="sm"
            >
              {saveMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              )}
              Сохранить
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
