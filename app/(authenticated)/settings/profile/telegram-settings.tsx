"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastSuccess, toastError } from "@/lib/toast";

type Preferences = {
  tgNotifyAssign: boolean;
  tgNotifyComment: boolean;
  tgNotifyMove: boolean;
  tgNotifyProject: boolean;
};

type Props = {
  connected: boolean;
  preferences: Preferences;
};

const PREF_LABELS: Record<keyof Preferences, string> = {
  tgNotifyAssign: "Назначение на задачу",
  tgNotifyComment: "Комментарии к моим задачам",
  tgNotifyMove: "Перемещение моих задач",
  tgNotifyProject: "Добавление в проект",
};

export function TelegramSettings({
  connected: initialConnected,
  preferences: initialPrefs,
}: Props) {
  const queryClient = useQueryClient();
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [botUsername, setBotUsername] = useState<string>("");

  // Poll connection status when code dialog is open
  const { data: statusData } = useQuery<{ connected: boolean } & Preferences>({
    queryKey: ["telegram-status"],
    queryFn: () => fetch("/api/profile/telegram/status").then((r) => r.json()),
    refetchInterval: codeDialogOpen ? 5000 : false,
  });

  const isConnected = statusData?.connected ?? initialConnected;
  const prefs: Preferences = statusData
    ? {
        tgNotifyAssign: statusData.tgNotifyAssign,
        tgNotifyComment: statusData.tgNotifyComment,
        tgNotifyMove: statusData.tgNotifyMove,
        tgNotifyProject: statusData.tgNotifyProject,
      }
    : initialPrefs;

  // Close dialog when connection succeeds
  if (codeDialogOpen && isConnected) {
    setCodeDialogOpen(false);
    setGeneratedCode(null);
    toastSuccess("Telegram подключён");
  }

  const generateCode = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/profile/telegram/generate-code", {
        method: "POST",
      });
      return res.json() as Promise<{
        code: string;
        expiresAt: string;
        botUsername: string;
      }>;
    },
    onSuccess: (data) => {
      setGeneratedCode(data.code);
      setBotUsername(data.botUsername);
      setCodeDialogOpen(true);
    },
    onError: () => {
      toastError("Ошибка генерации кода");
    },
  });

  const disconnect = useMutation({
    mutationFn: () =>
      fetch("/api/profile/telegram/disconnect", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      toastSuccess("Telegram отключён");
    },
  });

  const updatePref = useMutation({
    mutationFn: (update: Partial<Preferences>) =>
      fetch("/api/profile/telegram/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      toastSuccess("Сохранено");
    },
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isConnected ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Telegram не подключён. Подключите, чтобы получать уведомления.
              </p>
              <Button
                onClick={() => generateCode.mutate()}
                disabled={generateCode.isPending}
              >
                {generateCode.isPending
                  ? "Генерация..."
                  : "Подключить Telegram"}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-green-600">
                  Telegram подключён
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnect.mutate()}
                  disabled={disconnect.isPending}
                >
                  Отключить
                </Button>
              </div>

              <Separator />

              <div className="space-y-3">
                <p className="text-sm font-medium">Уведомления в Telegram</p>
                {(Object.keys(PREF_LABELS) as Array<keyof Preferences>).map(
                  (key) => (
                    <div
                      key={key}
                      className="flex items-center justify-between"
                    >
                      <Label htmlFor={key} className="text-sm">
                        {PREF_LABELS[key]}
                      </Label>
                      <Switch
                        id={key}
                        checked={prefs[key]}
                        onCheckedChange={(checked) =>
                          updatePref.mutate({ [key]: checked })
                        }
                      />
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={codeDialogOpen} onOpenChange={setCodeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Подключение Telegram</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Перейдите в бота и отправьте команду ниже:
            </p>
            <a
              href={`https://t.me/${botUsername || "controler_panel_bot"}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-md border px-4 py-3 hover:bg-accent transition-colors group"
            >
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">
                  Telegram-бот
                </p>
                <p className="text-sm font-medium">
                  @{botUsername || "controler_panel_bot"}
                </p>
              </div>
              <span className="text-xs text-primary group-hover:underline">
                Открыть →
              </span>
            </a>
            <div className="rounded-md bg-muted p-4 text-center">
              <code className="text-lg font-mono font-bold select-all">
                /start {generatedCode}
              </code>
            </div>
            <p className="text-xs text-muted-foreground">
              Код действует 10 минут. После привязки это окно закроется
              автоматически.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
